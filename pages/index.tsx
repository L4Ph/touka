import { useEffect, useRef, useState } from "react";
import { auth } from "void/client";
import { teamClient, type SessionStreamFrame } from "../shared/web-client";
import { applyEvent, emptyChat, textContent } from "../shared/chat-state";
import "./style.css";

type Client = ReturnType<typeof teamClient>;
type Directory = Extract<Awaited<ReturnType<Awaited<ReturnType<Client["api"]["sessions"]["$get"]>>["json"]>>, { sessions: unknown }> & { next?: string | null };
type Session = Directory["sessions"][number];
type Catalog = { provider: string; configured: boolean; models: { id: string; name: string }[] }[];
const jsonBody = (body: unknown) => ({ init: { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } });
async function checked<T>(response: { ok: boolean; status: number; json(): Promise<any> }): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.code ?? `Request failed (${response.status})`);
  return body as T;
}

export default function HomePage() {
  const [identity, setIdentity] = useState<{ data: Awaited<ReturnType<typeof auth.getSession>>["data"]; isPending: boolean }>({ data: null, isPending: true });
  useEffect(() => { void auth.getSession().then((result) => setIdentity({ data: result.data, isPending: false })).catch(() => setIdentity({ data: null, isPending: false })); }, []);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, select] = useState("");
  const [chat, setChat] = useState(emptyChat);
  const [catalog, setCatalog] = useState<Catalog>([]);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<{ session: string; operationId: string; input: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [connection, setConnection] = useState("Connecting");
  const [reconnect, setReconnect] = useState(0);
  const generation = useRef(0);
  const client = () => teamClient(window.location.origin);
  const route = () => client().api.sessions[":sessionId"];
  async function directory() {
    const all: Session[] = [];
    let after = "";
    do {
      const page = await checked<Directory>(await client().api.sessions.$get({ query: { after, limit: "50" } }));
      all.push(...page.sessions);
      after = "next" in page ? page.next ?? "" : "";
    } while (after);
    setSessions(all);
    return all;
  }
  async function refresh() {
    setLoading(true); setError("");
    try {
      await directory();
      const result = await checked<{ providers: Catalog }>(await client().api.models.$get());
      setCatalog(result.providers);
    } catch (failure) { setError(String(failure instanceof Error ? failure.message : failure)); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (identity.data) void refresh(); else { setSessions([]); select(""); } }, [identity.data?.user.id]);
  useEffect(() => {
    if (!selected || !identity.data) return;
    const current = ++generation.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let socket: WebSocket;
    setChat(emptyChat); setConnection("Connecting");
    const summary = async (updateModel = false) => {
      const value = await checked<Session>(await route().$get({ param: { sessionId: selected } }));
      if (disposed) return;
      setSessions((items) => items.map((item) => item.sessionId === selected ? value : item));
      if (updateModel) { setProvider(value.model?.provider ?? ""); setModel(value.model?.id ?? ""); }
    };
    const connect = () => {
      const url = new URL(`/api/agent/sessions/${encodeURIComponent(selected)}/events`, window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onmessage = (message) => {
        if (disposed || current !== generation.current) return;
        try {
          const frame: SessionStreamFrame = JSON.parse(message.data);
          setChat((state) => frame.type === "snapshot" ? applyEvent(state, frame.snapshot) : frame.events.reduce(applyEvent, state));
          setConnection("Connected");
          socket.send(JSON.stringify({ type: "ack", sequence: frame.sequence }));
          if (frame.type === "snapshot" || frame.events.some((event) => ["run_end", "inbox_update", "agent_changed"].includes(event.type)))
            void summary(frame.type === "snapshot" || frame.events.some((event) => event.type === "agent_changed")).catch((failure) => { if (!disposed) setError(failure.message); });
        } catch { setError("Invalid session stream. Reconnect to load a fresh snapshot."); socket.close(); }
      };
      socket.onclose = (event) => {
        if (disposed) return;
        if (event.code === 1008) { setChat(emptyChat); setSessions([]); setIdentity({ data: null, isPending: false }); }
        setConnection(event.code === 1008 ? "Session access expired. Sign in again." : "Offline — reconnecting");
        if (event.code !== 1008 && navigator.onLine) timer = setTimeout(connect, 1000);
      };
    };
    const offline = () => { clearTimeout(timer); socket?.close(); setConnection("Offline — waiting for network"); };
    const online = () => setReconnect((value) => value + 1);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    if (navigator.onLine) connect(); else offline();
    void summary(true).catch((failure) => { if (!disposed) setError(failure.message); });
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener("offline", offline); window.removeEventListener("online", online); socket?.close(); };
  }, [selected, reconnect, identity.data?.user.id]);

  async function action(work: () => Promise<void>) {
    setError(""); setSending(true);
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Request failed"); }
    finally { setSending(false); }
  }
  const active = sessions.find((item) => item.sessionId === selected);
  return <main>
    <title>Mandarin</title>
    <header><h1>Mandarin</h1>{identity.data && <button onClick={() => void action(async () => { await auth.signOut(); window.location.reload(); })}>Sign out</button>}</header>
    {identity.isPending ? <p role="status">Loading sign-in…</p> : !identity.data ? <section aria-label="Sign in"><h2>Welcome to Mandarin</h2><p>Sign in with your team account to share conversations.</p><button onClick={() => void action(async () => { const result = await auth.signIn.social({ provider: "github", callbackURL: "/" }); if (result.error) throw new Error(result.error.message); })}>Sign in with GitHub</button></section> : <div className="workspace">
      <aside aria-label="Team sessions"><h2>Team chats</h2><p>Shared by everyone on your team.</p><button disabled={sending} onClick={() => void action(async () => {
        const sessionId = crypto.randomUUID();
        await checked(await client().api.sessions.$post({}, jsonBody({ sessionId })));
        await directory(); select(sessionId);
      })}>New chat</button><button disabled={loading} onClick={() => void refresh()}>Refresh chats</button>
      {loading && <p role="status">Loading chats…</p>}
      {!loading && !sessions.length && <p>No chats yet. Start a Mandarin conversation.</p>}
      <ul>{sessions.map((item) => <li key={item.sessionId}><button aria-current={selected === item.sessionId ? "true" : undefined} onClick={() => select(item.sessionId)}>{item.sessionId}{item.busy ? " · running" : ""}</button></li>)}</ul></aside>
      <section className="conversation" aria-label="Conversation">
        {!selected ? <h2>Select a chat or start a new Mandarin conversation.</h2> : <>
          <h2>Chat</h2><p className="session-id">{selected}</p>
          <p role="status" aria-live="polite">{connection} · {chat.status}{active?.pending.some((item) => item.status === "parked") ? " · Parked — retry to resume" : ""}</p>
          <button onClick={() => setReconnect((value) => value + 1)}>Reconnect</button>
          <button disabled={sending} onClick={() => void action(async () => { await checked(await route().abort.$post({ param: { sessionId: selected } }, jsonBody({}))); })}>Stop shared run</button>
          <button disabled={sending} onClick={() => void action(async () => { const result = await checked<{ retried: boolean }>(await route().retry.$post({ param: { sessionId: selected } })); if (!result.retried) throw new Error("No parked work to retry"); })}>Retry parked work</button>
          <details><summary>Provider and model</summary><form onSubmit={(event) => { event.preventDefault(); void action(async () => { await checked(await route().model.$put({ param: { sessionId: selected } }, jsonBody({ provider, id: model }))); }); }}>
            <label htmlFor="provider">Provider</label><select id="provider" value={provider} onChange={(event) => { setProvider(event.target.value); setModel(""); }}><option value="">Select provider</option>{catalog.map((item) => <option key={item.provider}>{item.provider}</option>)}</select>
            <label htmlFor="model">Model</label><select id="model" value={model} onChange={(event) => setModel(event.target.value)}><option value="">Select model</option>{catalog.find((item) => item.provider === provider)?.models.map((item) => <option key={item.id} value={item.id} disabled={!catalog.find((entry) => entry.provider === provider)?.configured}>{item.name}</option>)}</select><button disabled={!provider || !model || sending}>Save model</button>
          </form><p>Changes affect the shared chat's next model call. Keys are managed by the operator.</p></details>
          <ol className="transcript" aria-label="Transcript">{chat.entries.flatMap((entry) => (entry.model ?? []).filter((message) => message.role !== "system").map((message, index) => <li key={`${entry.id}-${index}`}><strong>{message.role === "assistant" ? "Mandarin" : message.role}</strong><pre>{textContent(message)}</pre>{message.role === "assistant" && ["error", "aborted"].includes(message.stopReason) && <p>Unanswered: {message.errorMessage ?? message.stopReason}</p>}</li>))}</ol>
          {!chat.entries.length && <p>Ask Mandarin anything to begin.</p>}
          {chat.partial && <div aria-label="Streaming response"><strong>Mandarin</strong><pre>{chat.partial}</pre></div>}
          <ul aria-label="Tool activity">{Object.entries(chat.tools).map(([id, tool]) => <li key={id}>{tool.name}: {tool.done ? "Finished" : "Running"}{tool.output && <pre>{tool.output}</pre>}</li>)}</ul>
          <form onSubmit={(event) => { event.preventDefault(); const submission = pending?.session === selected ? pending : { session: selected, operationId: crypto.randomUUID(), input: draft }; setPending(submission); void action(async () => {
            await checked(await route().inputs.$post({ param: { sessionId: submission.session } }, jsonBody({ operationId: submission.operationId, input: submission.input })));
            setPending(null); setDraft("");
          }); }}><label htmlFor="message">Message Mandarin</label><textarea id="message" value={pending?.session === selected ? pending.input : draft} disabled={sending || pending?.session === selected} onChange={(event) => setDraft(event.target.value)} required />
          <button disabled={sending || !(pending?.session === selected || draft.trim())}>{sending ? "Sending…" : pending?.session === selected ? "Retry same message" : "Send message"}</button></form>
          {pending?.session === selected && <p>Delivery not confirmed. Retry uses the same operation ID; do not start a duplicate message.</p>}
        </>}
      </section>
    </div>}
    {error && <div role="alert"><p>{error}</p><button onClick={() => setError("")}>Dismiss error</button></div>}
  </main>;
}
