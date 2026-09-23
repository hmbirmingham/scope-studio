export default function Sidebar({ projects, activeProject, onSelectProject, onOpenProjectSettings, onOpenSources }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-logo">
          <span className="logo-mark" />
          Scope
        </div>
      </div>

      <nav className="sidebar-nav">
        <button type="button" className="nav-item is-active">New query</button>
        <button type="button" className="nav-item">Search map</button>
        <button type="button" className="nav-item" onClick={onOpenSources}>Sources</button>
        <button type="button" className="nav-item">Settings</button>
      </nav>

      <div className="sidebar-section">
        Maps
        <button type="button" className="sidebar-add" onClick={onOpenSources} aria-label="Add sources">+</button>
      </div>
      <div className="sidebar-nav">
        {projects.map(({ project, nodes, privacy }) => (
          <div
            key={project}
            className={`map-item ${project === activeProject ? 'is-active' : ''}`}
          >
            <button type="button" className="map-item-name" onClick={() => onSelectProject(project)}>
              {project.split('/').pop()}
              <span className="map-item-count">{nodes}</span>
              {privacy === 'local' && <span className="map-item-local" title="stays on this machine">■</span>}
            </button>
            <button
              type="button"
              className="map-item-more"
              aria-label={`${project} settings`}
              onClick={() => onOpenProjectSettings(project)}
            >
              ⋮
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-spacer" />

      <div className="sidebar-user">
        <div className="avatar">H</div>
        <span className="user-name">Hynes</span>
      </div>
    </aside>
  );
}
