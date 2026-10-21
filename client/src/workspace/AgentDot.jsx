// The agent's colour, as on its map cursor. Decorative unless given a label.
export default function AgentDot({ color, label }) {
  return (
    <span
      className="ws-dot"
      style={{ '--agent': color ?? '#8a8a96' }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
