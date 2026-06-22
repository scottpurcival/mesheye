import { state } from './state.js';

export function updateStatus() {
  const located = [...state.nodes.values()].filter(n => n.lat != null).length;
  const unlocated = state.nodes.size - located;
  const syncStr = state.lastSyncTime
    ? state.lastSyncTime.toLocaleTimeString()
    : 'Never';

  document.getElementById('statusbar').textContent =
    `${located} nodes located | ${unlocated} unlocated | ${state.packets.size} links | Last sync ${syncStr} | Auto-refresh every 5 min`;

  // Populate unlocated list in layers panel
  const listEl = document.getElementById('unlocated-list');
  const unlocatedNodes = [...state.nodes.values()].filter(n => n.lat == null);
  listEl.textContent = '';
  if (unlocatedNodes.length === 0) return;

  const header = document.createElement('strong');
  header.style.color = '#4fc3f7';
  header.textContent = `Unlocated nodes (${unlocatedNodes.length}):`;
  listEl.appendChild(header);

  for (const n of unlocatedNodes) {
    listEl.appendChild(document.createElement('br'));
    listEl.appendChild(document.createTextNode(`• ${n.name} (${n.role})`));
  }
}
