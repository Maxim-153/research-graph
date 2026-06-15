import dagre from 'dagre';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 88;
const GRID_X_GAP = 210;
const GRID_Y_GAP = 118;

const getGridColumns = (count) => Math.max(1, Math.ceil(Math.sqrt(count * 1.35)));

const layoutAsGrid = (nodes, startX = 0, startY = 0) => {
  const columns = getGridColumns(nodes.length);

  return nodes.map((node, index) => ({
    ...node,
    position: {
      x: startX + (index % columns) * GRID_X_GAP,
      y: startY + Math.floor(index / columns) * GRID_Y_GAP,
    },
  }));
};

const getBounds = (nodes) => nodes.reduce((bounds, node) => {
  const x = node.position?.x || 0;
  const y = node.position?.y || 0;

  return {
    minX: Math.min(bounds.minX, x),
    maxX: Math.max(bounds.maxX, x + NODE_WIDTH),
    minY: Math.min(bounds.minY, y),
    maxY: Math.max(bounds.maxY, y + NODE_HEIGHT),
  };
}, {
  minX: Infinity,
  maxX: -Infinity,
  minY: Infinity,
  maxY: -Infinity,
});

export const getLayoutedElements = (nodes, edges, direction = 'TB') => {
  if (nodes.length === 0) return { nodes, edges };

  const connectedIds = new Set();
  edges.forEach((edge) => {
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
  });

  if (connectedIds.size === 0) {
    return { nodes: layoutAsGrid(nodes), edges };
  }

  const connectedNodes = nodes.filter((node) => connectedIds.has(node.id));
  const isolatedNodes = nodes.filter((node) => !connectedIds.has(node.id));
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({
    rankdir: direction,
    nodesep: 44,
    ranksep: 70,
    align: 'DL',
  });

  connectedNodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  edges.forEach((edge) => {
    if (connectedIds.has(edge.source) && connectedIds.has(edge.target)) {
      dagreGraph.setEdge(edge.source, edge.target);
    }
  });

  dagre.layout(dagreGraph);

  const layoutedConnectedNodes = connectedNodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - NODE_WIDTH / 2,
        y: nodeWithPosition.y - NODE_HEIGHT / 2,
      },
    };
  });

  if (isolatedNodes.length === 0) {
    return { nodes: layoutedConnectedNodes, edges };
  }

  const bounds = getBounds(layoutedConnectedNodes);
  const gridColumns = getGridColumns(isolatedNodes.length);
  const gridWidth = (gridColumns - 1) * GRID_X_GAP + NODE_WIDTH;
  const connectedCenter = Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxX)
    ? (bounds.minX + bounds.maxX) / 2
    : gridWidth / 2;
  const startX = connectedCenter - gridWidth / 2;
  const startY = Number.isFinite(bounds.maxY) ? bounds.maxY + 130 : 0;
  const layoutedIsolatedNodes = layoutAsGrid(isolatedNodes, startX, startY);

  return { nodes: [...layoutedConnectedNodes, ...layoutedIsolatedNodes], edges };
};
