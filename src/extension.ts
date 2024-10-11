import * as vscode from 'vscode';
import * as http from 'http';

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

let server: http.Server | undefined;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
    const logger = new Logger(vscode.l10n.t('CodeContext::Logs'));

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('codecontext.startServer', startServer),
        vscode.commands.registerCommand('codecontext.stopServer', stopServer),
        vscode.commands.registerCommand('codecontext.showLog', () => logger.show()),
        vscode.commands.registerCommand('codecontext.restart', restartServer)
    );

    function startServer() {
        if (server) {
            vscode.window.showInformationMessage('Server is already running.');
            return;
        }

        server = http.createServer((req, res) => {
            if (req.url === '/api/context') {
                const openEditors = vscode.window.tabGroups.all.flatMap(group => group.tabs);
                let extractedText = ['CodeContext: These are the current open editors below'];

                openEditors.forEach((tab) => {
                    if (tab.input instanceof vscode.TabInputText) {
                        const uri = tab.input.uri;
                        extractedText.push(uri.fsPath);
                        
                        // Attempt to get the document content
                        const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === uri.fsPath);
                        if (document) {
                            extractedText.push(document.getText());
                        } else {
                            extractedText.push('(Content not available)');
                        }
                    }
                });

                let extractedTextString = extractedText.join("\n");
                
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(extractedTextString);
            }
        });

        server.listen(6969, () => {
            console.log('API server is running on port 6969');
            updateStatusBar(true);
            logger.log('info', 'Server started on port 6969');
            vscode.commands.executeCommand('setContext', 'codecontextIsRunning', true);
        });
    }

    function stopServer() {
        if (server) {
            server.close(() => {
                server = undefined;
                console.log('API server stopped');
                updateStatusBar(false);
                logger.log('info', 'Server stopped');
                vscode.commands.executeCommand('setContext', 'codecontextIsRunning', false);
            });
        } else {
            vscode.window.showInformationMessage('Server is not running.');
        }
    }

    function restartServer() {
        stopServer();
        setTimeout(startServer, 1000); // Wait for 1 second before restarting
    }

    function updateStatusBar(isRunning: boolean) {
        if (isRunning) {
            statusBarItem.text = "$(radio-tower) Server: Running on port 6969";
            statusBarItem.command = 'codecontext.stopServer';
            statusBarItem.tooltip = 'Click to stop server';
        } else {
            statusBarItem.text = "$(circle-slash) Server: Stopped";
            statusBarItem.command = 'codecontext.startServer';
            statusBarItem.tooltip = 'Click to start server';
        }
        statusBarItem.show();
    }

    updateStatusBar(false);
}

export function deactivate() {
    if (server) {
        server.close();
    }
}