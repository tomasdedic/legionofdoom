new AI software factory experiment, modeled after a human eng team:

for each of this checkpoint create a directory with source code

- multiple pi-durable agents (./pi-durable-gothrough/)
  - example implementation is already done but check it for possible changes also pi-durable itself changes
  - create webui interface
- each w/ their own container (podman, kuberntes manifests)
- each has a role/persona, works towards common goal
- private IRC server for collab (podman), they can cooperate or message through IRC channel (define a tool to send message to irc channel)
- eng rituals: daily standups, "review my pr", "summarize day in agent life", what problems did I hit
