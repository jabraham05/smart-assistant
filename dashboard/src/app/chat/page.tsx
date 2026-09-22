// Server Component so this reads the *runtime* env var (set via
// docker-compose `environment:`) on every render - a client component
// reading `process.env` directly would only ever see whatever was baked in
// at `next build` time, which is empty here since the value isn't known
// until the container actually starts.
//
// force-dynamic is required for the same reason: without it, Next.js
// statically prerenders this page once during `next build` (inside the
// Docker build stage, before the container - and its env vars - exist) and
// serves that frozen HTML forever, which bakes in "not set" permanently.
// Confirmed live: removing this line reproduces exactly that failure even
// though `docker compose exec dashboard printenv` shows the var is set.
export const dynamic = "force-dynamic";

export default function ChatPage() {
  const chatUiUrl = process.env.CHAT_UI_PUBLIC_URL;

  if (!chatUiUrl) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        CHAT_UI_PUBLIC_URL is not set - check the dashboard service&apos;s
        environment in docker-compose.yml.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <h1 className="mb-3 text-lg font-semibold">Chat</h1>
      <p className="mb-3 text-sm text-black/60 dark:text-white/60">
        This embeds chat-ui directly - live chat and past-session history are
        both available inside it (see the session list in its own UI).
      </p>
      <iframe
        src={chatUiUrl}
        title="Chat with Amy"
        className="h-full min-h-0 flex-1 rounded-md border border-black/10 dark:border-white/10"
      />
    </div>
  );
}
