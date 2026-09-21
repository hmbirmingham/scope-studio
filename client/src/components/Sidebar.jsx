export default function Sidebar({ projects, activeProject, onSelectProject, onOpenProjectSettings }) {
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
        <button type="button" className="nav-item">Library</button>
        <button type="button" className="nav-item">Settings</button>
      </nav>

      <div className="sidebar-section">Maps</div>
      <div className="sidebar-nav">
        {projects.map((project) => (
          <div
            key={project}
            className={`map-item ${project === activeProject ? 'is-active' : ''}`}
          >
            <button type="button" className="map-item-name" onClick={() => onSelectProject(project)}>
              {project}
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
