export default function subagentRouter(pi) {
  pi.events.on("pi-auto-router:subagent", (state) => { state.subagent = true; });
}
