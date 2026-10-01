import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Answers arrive as markdown: bold, lists, tables, code. react-markdown builds
// React elements and never renders raw HTML from the text, which matters here
// because answers quote repository content verbatim.
const COMPONENTS = {
  // Links leave the app; they never navigate it away.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

const PLUGINS = [remarkGfm];

export default function AnswerText({ text }) {
  return (
    <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
      {text}
    </Markdown>
  );
}
