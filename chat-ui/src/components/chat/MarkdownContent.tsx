import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

// Real gap found via live testing: MessageBubble used to render
// `message.content` as plain text - React auto-escapes everything, so a
// reply's **bold**, numbered lists, and (critically) a markdown link like
// [read the full findings here](url) all showed up as literal raw
// characters instead of a real, clickable link. The model was already
// producing correct markdown (see research_task_status's documentUrl
// fix) - nothing on the client ever rendered it.
//
// `isUser` swaps link/code colors for the user's solid blue bubble, where
// the assistant-bubble palette (blue-600/gray-100) would either vanish
// against the background or clash with it.
export function MarkdownContent({ content, isUser }: { content: string; isUser: boolean }) {
  const linkClass = isUser
    ? "underline decoration-blue-200 hover:decoration-white"
    : "text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300";
  const codeClass = isUser
    ? "rounded bg-blue-700/50 px-1 py-0.5 font-mono text-[13px]"
    : "rounded bg-black/10 px-1 py-0.5 font-mono text-[13px] dark:bg-white/10";

  const components: Components = {
    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0">{children}</ol>,
    li: ({ children }) => <li className="leading-snug">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    h1: ({ children }) => <h1 className="mb-1 mt-2 text-base font-semibold first:mt-0">{children}</h1>,
    h2: ({ children }) => <h2 className="mb-1 mt-2 text-base font-semibold first:mt-0">{children}</h2>,
    h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h3>,
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={linkClass}
        // Stops the click from also bubbling up to the bubble's own
        // onClick (opens turn detail) - the link should just navigate.
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </a>
    ),
    code: ({ children }) => <code className={codeClass}>{children}</code>,
    pre: ({ children }) => <pre className="mb-2 overflow-x-auto last:mb-0">{children}</pre>,
    blockquote: ({ children }) => (
      <blockquote className="mb-2 border-l-2 border-current/30 pl-2 opacity-90 last:mb-0">{children}</blockquote>
    ),
  };

  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
