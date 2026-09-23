import { useState } from 'react';

export default function ChatPanel({ project }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');

  function handleSubmit(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setDraft('');
  }

  return (
    <aside className="chat-panel">
      <header className="chat-head">
        <span className="chat-title">{project ?? 'All maps'}</span>
        <span className="chat-model">
          <span className="model-dot" />
          retrieval only
        </span>
      </header>

      <div className="chat-log">
        {messages.length === 0 && <p className="chat-empty">Ask your map.</p>}
        {messages.map((message, index) => (
          <div className="chat-message" key={index}>
            <div className="chat-who">Hynes</div>
            <div className="chat-body">{message.text}</div>
          </div>
        ))}
      </div>

      <form className="chat-input" onSubmit={handleSubmit}>
        <textarea
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask your map"
        />
        <button type="submit" aria-label="Send">↑</button>
      </form>
    </aside>
  );
}
