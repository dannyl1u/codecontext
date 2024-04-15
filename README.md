# codecontext

llms support long context and it's more beneficial to 
share context from your files to any current llm subscription you have

this will save you money and time, since you won't need to purchase copilot,
sourcegraph cody, use your api key, etc


# motivation
- the best RAG performance is: you understanding the codebase and putting effort in tracing the logic. codebases are just a huge factorio map
- current agents don't perform well with opening relevant files, and take an extremely long time contributing value when you could just increase your prompting skills and save money now
- why would you rob yourself from onbboarding to a new codebase and understanding it
- this tool simply allows you to copy paste quicker and use the best model you know to tackle the issue, saving you ~20/month

# features
- starts a public facing tunnel for your code context, allowing you to easily integrate with other GPT wrappers, or huggingchat
- gets the context from the opened files


# future
- add feature to knowledge distill from the open files, to improve performance of GPT / Anthropic long context performance
    - `/api/context/distilled`
    - this assumes current LLMs perform worse the more context you give it, if you give it 100k context and ask some cognitive task, it will likely perform worse than if you knowledge distill that 100k context and feed the most relevant from that
    - different techniques to knowledge distill:
        - brute force LLM pass through (ask claude haiku if snippet is relevant to query)
        - vectorDB search and rerank with cohere rerank
        - integrate with phorm.ai and leverage their repo-level vector search

- private context sharing, allow sign in with github on the client side
- create a frontend that integrates with this service

# how to use
- use vscode insiders (we use code-tunnels to port forward the context which is in preview mode right now)
- clone repo
- npm i 
- press run and debug 
- new vscode insiders window pops up
- now press cmd shift p
- look up `codecontext` and press `share context`
- agree to public port opening (future we will support private ports)

