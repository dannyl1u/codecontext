
// extension.ts

import * as vscode from 'vscode';
import * as http from 'http';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { DeferredPromise } from './deferredPromise';

import * as path from 'path';
import { splitNewLines } from './split';

export const enum TunnelPrivacyId {
	Private = 'private',
	Public = 'public',
}

// This is used as a global variable to set if the user was warned or not before opening
// a public port
const didWarnPublicKey = 'didWarnPublic';

/**
 * Timeout after the last port forwarding is disposed before we'll tear down
 * the CLI. This is primarily used since privacy changes to port will appear
 * as a dispose+re-create call, and we don't want to have to restart the CLI.
 */
const CLEANUP_TIMEOUT = 10_000;


// This is the state for the tunnel being provided or not
const enum State {
	Starting,
	Active,
	Inactive,
	Error,
}

type StateT =
	| { state: State.Inactive }
	| { state: State.Starting; process: ChildProcessWithoutNullStreams; cleanupTimeout?: NodeJS.Timeout }
	| { state: State.Active; portFormat: string; process: ChildProcessWithoutNullStreams; cleanupTimeout?: NodeJS.Timeout }
	| { state: State.Error; error: string };



class Tunnel implements vscode.Tunnel {
	private readonly disposeEmitter = new vscode.EventEmitter<void>();
	public readonly onDidDispose = this.disposeEmitter.event;
	public localAddress!: string;

	constructor(
		public readonly remoteAddress: { port: number; host: string },
		public readonly privacy: TunnelPrivacyId,
	) { }

	public setPortFormat(formatString: string) {
		this.localAddress = formatString.replace('{port}', String(this.remoteAddress.port));
	}

	dispose() {
		this.disposeEmitter.fire();
	}
}

class TunnelProvider implements vscode.TunnelProvider {
	private readonly tunnels = new Set<Tunnel>();
	private readonly stateChange = new vscode.EventEmitter<StateT>();
	private _state: StateT = { state: State.Inactive };

	private get state(): StateT {
		return this._state;
	}

	private set state(state: StateT) {
		this._state = state;
		this.stateChange.fire(state);
	}

	public readonly onDidStateChange = this.stateChange.event;

	constructor(private readonly logger: Logger, private readonly context: vscode.ExtensionContext) { }

	/** @inheritdoc */
	public async provideTunnel(tunnelOptions: vscode.TunnelOptions): Promise<vscode.Tunnel | undefined> {
		if (tunnelOptions.privacy === TunnelPrivacyId.Public) {
			if (!(await this.consentPublicPort(tunnelOptions.remoteAddress.port))) {
				return;
			}
		}

		const tunnel = new Tunnel(
			tunnelOptions.remoteAddress,
			(tunnelOptions.privacy as TunnelPrivacyId) || TunnelPrivacyId.Private,
		);

		this.tunnels.add(tunnel);
		tunnel.onDidDispose(() => {
			this.tunnels.delete(tunnel);
			this.updateActivePortsIfRunning();
		});

		switch (this.state.state) {
			case State.Error:
			case State.Inactive:
				await this.setupPortForwardingProcess();
			// fall through since state is now starting
			case State.Starting:
				this.updateActivePortsIfRunning();
				return new Promise<Tunnel>((resolve, reject) => {
					const l = this.stateChange.event(state => {
						if (state.state === State.Active) {
							tunnel.setPortFormat(state.portFormat);
							l.dispose();
							resolve(tunnel);
						} else if (state.state === State.Error) {
							l.dispose();
							reject(new Error(state.error));
						}
					});
				});
			case State.Active:
				tunnel.setPortFormat(this.state.portFormat);
				this.updateActivePortsIfRunning();
				return tunnel;
		}
	}

	/** Re/starts the port forwarding system. */
	public async restart() {
		this.killRunningProcess();
		await this.setupPortForwardingProcess(); // will show progress
		this.updateActivePortsIfRunning();
	}

	private async consentPublicPort(portNumber: number) {
		const didWarn = this.context.globalState.get(didWarnPublicKey, false);
		if (didWarn) {
			return true;
		}

		const continueOpt = vscode.l10n.t('Continue');
		const dontShowAgain = vscode.l10n.t("Don't show again");
		const r = await vscode.window.showWarningMessage(
			vscode.l10n.t("You're about to create a publicly forwarded port. Anyone on the internet will be able to connect to the service listening on port {0}. You should only proceed if this service is secure and non-sensitive.", portNumber),
			{ modal: true },
			continueOpt,
			dontShowAgain,
		);
		if (r === continueOpt) {
			// continue
		} else if (r === dontShowAgain) {
			await this.context.globalState.update(didWarnPublicKey, true);
		} else {
			return false;
		}

		return true;
	}

	private isInStateWithProcess(process: ChildProcessWithoutNullStreams) {
		return (
			(this.state.state === State.Starting || this.state.state === State.Active) &&
			this.state.process === process
		);
	}

	private killRunningProcess() {
		if (this.state.state === State.Starting || this.state.state === State.Active) {
			this.logger.log('info', '[forwarding] no more ports, stopping forwarding CLI');
			this.state.process.kill();
			this.state = { state: State.Inactive };
		}
	}

	public updateActivePortsIfRunning() {
		if (this.state.state !== State.Starting && this.state.state !== State.Active) {
			return;
		}

		const ports = [...this.tunnels].map(t => ({ number: t.remoteAddress.port, privacy: t.privacy }));
		this.state.process.stdin.write(`${JSON.stringify(ports)}\n`);

		if (ports.length === 0 && !this.state.cleanupTimeout) {
			this.state.cleanupTimeout = setTimeout(() => this.killRunningProcess(), CLEANUP_TIMEOUT);
		} else if (ports.length > 0 && this.state.cleanupTimeout) {
			clearTimeout(this.state.cleanupTimeout );
			this.state.cleanupTimeout = undefined;
		}
	}

	private async setupPortForwardingProcess() {
		const session = await vscode.authentication.getSession('github', ['user:email', 'read:org'], {
			createIfNone: true,
		});

		const args = [
			'--verbose',
			'tunnel',
			'forward-internal',
			'--provider',
			'github',
			'--access-token',
			session.accessToken,
		];

		this.logger.log('info', '[forwarding] starting CLI');
		const child = spawn(cliPath, args, { stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } });
		this.state = { state: State.Starting, process: child };

		const progressP = new DeferredPromise<void>();
		vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t({
					comment: ['do not change link format [Show Log](command), only change the text "Show Log"'],
					message: 'Starting port forwarding system ([Show Log]({0}))',
					args: ['command:codecontext.showLog']
				}),
			},
			() => progressP.p,
		);

		let lastPortFormat: string | undefined;
		child.on('exit', status => {
			const msg = `[forwarding] exited with code ${status}`;
			this.logger.log('info', msg);
			progressP.complete(); // make sure to clear progress on unexpected exit
			if (this.isInStateWithProcess(child)) {
				this.state = { state: State.Error, error: msg };
			}
		});

		child.on('error', err => {
			this.logger.log('error', `[forwarding] ${err}`);
			progressP.complete(); // make sure to clear progress on unexpected exit
			if (this.isInStateWithProcess(child)) {
				this.state = { state: State.Error, error: String(err) };
			}
		});

		child.stdout
			.pipe(splitNewLines())
			.on('data', line => {
				this.logger.log('info', `[forwarding] ${line}`);
				// if (line.includes("forwarding port") && line.includes("at Public")) {
				// 	this.state = {
				// 		state: State.Active,
				// 		portFormat: `http://localhost:6969`,
				// 		process: child,
				// 		cleanupTimeout: setTimeout(() => console.log("hi timeout"), CLEANUP_TIMEOUT),
				// 	};
				// 	progressP.complete(); // Indicating that we have successfully moved to the Active state
					
				// }
			})
			.resume();

		child.stderr
			.pipe(splitNewLines())
			.on('data', line => {
				try {
					const l: { port_format: string } = JSON.parse(line);
					if (l.port_format && l.port_format !== lastPortFormat) {
						this.state = {
							state: State.Active,
							portFormat: l.port_format, process: child,
							cleanupTimeout: 'cleanupTimeout' in this.state ? this.state.cleanupTimeout : undefined,
						};
						progressP.complete();
					}
				} catch (e) {
					this.logger.log('error', `[forwarding] ${line}`);
				}
			})
			.resume();

		await new Promise((resolve, reject) => {
			child.on('spawn', resolve);
			child.on('error', reject);
		});
	}
}

class Logger {
	private outputChannel?: vscode.LogOutputChannel;

	constructor(private readonly label: string) { }

	public show(): void {
		return this.outputChannel?.show();
	}

	public clear() {
		this.outputChannel?.clear();
	}

	public log(
		logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error',
		message: string,
		...args: unknown[]
	) {
		if (!this.outputChannel) {
			this.outputChannel = vscode.window.createOutputChannel(this.label, { log: true });
			vscode.commands.executeCommand('setContext', 'codecontextHasLog', true);
		}
		this.outputChannel[logLevel](message, ...args);
	}
}

const cliPath = process.env.VSCODE_FORWARDING_IS_DEV
	? path.join(__dirname, '../../../cli/target/debug/code')
	: path.join(
		vscode.env.appRoot,
		process.platform === 'darwin' ? 'bin' : '../../bin',
		vscode.env.appQuality === 'stable' ? 'code-tunnel' : 'code-tunnel-insiders',
	) + (process.platform === 'win32' ? '.exe' : '');

export async function activate(context: vscode.ExtensionContext) {
	// if (vscode.env.remoteAuthority) {
	// 	return; // forwarding is local-only at the moment
	// }

	const logger = new Logger(vscode.l10n.t('CodeContext::PortForwarding::Logs'));

	const tunnelProvider = new TunnelProvider(logger, context);

	context.subscriptions.push(
		vscode.commands.registerCommand('codecontext.setupServer', () => {
			// Your command implementation here.
		  }),
		vscode.commands.registerCommand('codecontext.showLog', () => logger.show()),
		vscode.commands.registerCommand('codecontext.restart', () => tunnelProvider.restart()),

		tunnelProvider.onDidStateChange(s => {
			vscode.commands.executeCommand('setContext', 'codecontextIsRunning', s.state !== State.Inactive);
		}),

		await vscode.workspace.registerTunnelProvider(
			tunnelProvider,
			{
				
				tunnelFeatures: {
					elevation: false,
					protocol: false,
					privacyOptions: [
						{ themeIcon: 'globe', id: TunnelPrivacyId.Public, label: vscode.l10n.t('Public') },
						{ themeIcon: 'lock', id: TunnelPrivacyId.Private, label: vscode.l10n.t('Private') },
					],
				},
			},
		),
	);

	// Set up the HTTP server
	const server = http.createServer((req, res) => {
		if (req.url === '/api/context') {

			const openTextDocuments = vscode.workspace.textDocuments;
			let extractedText = ['CodeContext: These are the current open files below'];

			openTextDocuments.forEach((document) => {
				if (!document.fileName.endsWith('.git') && document.fileName.includes(".")) {
				  extractedText.push(document.fileName);
				  extractedText.push(document.getText());
				}
			  });

			let extractedTextString = extractedText.join("\n");
			
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end(extractedTextString);

			// const alertUserContextWasShared = vscode.window.showInformationMessage('Shared Context');
			
			// setTimeout(() => {
			// 	alertUserContextWasShared.then(item => item?.dismiss());
			// }, 3000);
		}
	});

	server.listen(6969, async () => {
		console.log('API server is running on port 6969');
		openPublicPort(6969, logger, tunnelProvider);
	});
}


export function deactivate() { }


async function openPublicPort(port: number, logger: Logger, tunnelProvider: TunnelProvider) {
	const tunnelOptions: vscode.TunnelOptions = {
		remoteAddress: {
			port: port,
			host: 'localhost',
		},
		privacy: TunnelPrivacyId.Public,
	};

	
	const tunnel = await tunnelProvider.provideTunnel(tunnelOptions);

	if (tunnel) {
		console.log(`Port forwarding for port ${port} has been set up.`);
		// tunnelProvider.onDidStateChange();
		// tunnelProvider.updateActivePortsIfRunning();
	} else {
		console.error(`Failed to set up port forwarding for port ${port}.`);
	}
}
