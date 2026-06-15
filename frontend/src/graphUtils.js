import { getLayoutedElements } from './layoutUtils';

export const GRAPH_MODES = {
  PAPERS: 'papers',
  AUTHORS: 'authors',
};

const CLUSTER_COLORS = ['#f9c6d3', '#b9d8dc', '#bde7b0', '#f4e38a', '#d9c2ea', '#f2c38b'];
const AUTHOR_COLORS = ['#d9f2e6', '#d9e8ff', '#fff0c2', '#f8d8d8', '#e6ddff', '#d7f4f2'];

export const getClusterColor = (groupNumber = 0) => {
  const safeIndex = Number.isFinite(groupNumber) ? groupNumber : 0;
  return CLUSTER_COLORS[Math.abs(safeIndex) % CLUSTER_COLORS.length];
};

export const decoratePaperNode = (node, options = {}) => {
  const { isNew = false } = options;

  return {
    ...node,
    data: {
      ...node.data,
      type: 'paper',
    },
    position: node.position || { x: 0, y: 0 },
    style: {
      // Карточка подгоняется под заголовок: узкая, высота растёт под полный текст
      // (короткий заголовок → маленькая карточка, длинный → выше; без обрезки).
      width: 200,
      minHeight: 46,
      backgroundColor: getClusterColor(node.data?.group),
      borderRadius: 8,
      padding: 10,
      border: isNew ? '2px solid #f59e0b' : '1px solid #475569',
      boxShadow: isNew
        ? '0 12px 26px rgba(245, 158, 11, 0.26)'
        : '0 10px 22px rgba(15, 23, 42, 0.14)',
      color: '#111827',
      fontSize: 13,
      lineHeight: 1.25,
    },
  };
};

export const dedupeEdges = (edges = []) => {
  const seen = new Set();
  const result = [];

  edges.forEach((edge) => {
    if (!edge?.source || !edge?.target || edge.source === edge.target) return;

    const id = edge.id || `e-${edge.source}-${edge.target}`;
    const key = `${edge.source}->${edge.target}`;
    if (seen.has(key)) return;

    seen.add(key);
    result.push({ ...edge, id });
  });

  return result;
};

const normalizeDedupeText = (value = '') => String(value)
  .trim()
  .toLowerCase()
  .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
  .replace(/\s+/g, ' ');

export const getNodeDedupeKey = (node) => {
  const data = node?.data || {};
  const doi = normalizeDedupeText(data.doi || data.url);
  if (doi && !doi.includes('openalex.org')) return `doi:${doi}`;

  const title = normalizeDedupeText(data.label || data.title);
  const year = data.year || data.publication_year || '';
  if (title) return `title:${title}:${year}`;

  return node?.id ? `id:${node.id}` : '';
};

export const dedupeNodes = (nodes = []) => {
  const seen = new Map();

  nodes.forEach((node) => {
    if (!node?.id) return;

    const key = getNodeDedupeKey(node);
    if (!key || !seen.has(key)) {
      seen.set(key || `id:${node.id}`, node);
      return;
    }

    const existingNode = seen.get(key);
    seen.set(key, {
      ...existingNode,
      data: {
        ...node.data,
        ...existingNode.data,
      },
      position: existingNode.position || node.position,
      style: {
        ...node.style,
        ...existingNode.style,
      },
    });
  });

  return Array.from(seen.values());
};

export const filterEdgesForNodes = (edges = [], nodesOrIds = []) => {
  const nodeIds = nodesOrIds instanceof Set
    ? nodesOrIds
    : new Set(nodesOrIds.map((node) => node.id));

  return dedupeEdges(
    edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
  );
};

// ── Типы рёбер многосвязного графа ─────────────────────────────────────────
// Бэкенд (graph_edges.py) присылает рёбра с data.kinds = ['citation'|'coupling'|
// 'semantic', ...] (одно ребро на пару статей, объединяющее все типы связи между
// ними) и data.weights = { kind: weight }.
export const EDGE_KIND_META = {
  citation: {
    label: 'Цитирование',
    color: '#94a3b8',
    dash: '',
    desc: 'A напрямую ссылается на B (B есть в списке литературы A). Прямой факт цитирования.',
  },
  coupling: {
    label: 'Сопряжение',
    color: '#a855f7',
    dash: '6 4',
    desc: 'A и B ссылаются на общие источники. Вероятно, об одном, даже если не цитируют друг друга. Вес = число общих источников.',
  },
  semantic: {
    label: 'Семантика',
    color: '#34d399',
    dash: '2 4',
    desc: 'Аннотации A и B близки по смыслу (косинус эмбеддингов). Тематически похожи, даже без общих ссылок.',
  },
};

const EDGE_KIND_ORDER = ['citation', 'coupling', 'semantic'];

export const getEdgeKinds = (edge) => {
  const kinds = edge?.data?.kinds;
  if (Array.isArray(kinds) && kinds.length) return kinds;
  if (edge?.data?.kind) return [edge.data.kind];
  return [];
};

// Тип, по которому ребро сейчас показываем: старший по приоритету среди активных.
export const getEdgeActiveKind = (edge, activeKinds) => (
  EDGE_KIND_ORDER.find((kind) => getEdgeKinds(edge).includes(kind) && activeKinds?.[kind])
);

// Ребро видимо, если включён хотя бы один его тип. Рёбра без типа (граф авторов) —
// всегда видимы.
export const isEdgeVisible = (edge, activeKinds) => {
  const kinds = getEdgeKinds(edge);
  if (kinds.length === 0) return true;
  return kinds.some((kind) => activeKinds?.[kind]);
};

export const filterEdgesByKind = (edges = [], activeKinds) => (
  edges.filter((edge) => isEdgeVisible(edge, activeKinds))
);

// Рёбра-цитирования — для Influence Score и Research Gaps: структура должна быть
// стабильной и не зависеть от семантического/библиографического слоёв.
export const getCitationEdges = (edges = []) => (
  edges.filter((edge) => getEdgeKinds(edge).includes('citation'))
);

// Структурные рёбра для раскладки Dagre: цитирование + сопряжение (без плотной
// семантической паутины, чтобы не разрушать иерархию).
export const getStructuralEdges = (edges = []) => (
  edges.filter((edge) => {
    const kinds = getEdgeKinds(edge);
    if (kinds.length === 0) return true;
    return kinds.includes('citation') || kinds.includes('coupling');
  })
);

// Базовый стиль ребра по его активному типу (для рендера).
export const getEdgeKindStyle = (edge, activeKinds) => {
  const kind = getEdgeActiveKind(edge, activeKinds) || getEdgeKinds(edge)[0] || 'citation';
  const meta = EDGE_KIND_META[kind] || EDGE_KIND_META.citation;
  const weight = Number(edge?.data?.weights?.[kind]) || 1;

  if (kind === 'coupling') {
    return { stroke: meta.color, strokeWidth: Math.min(4, 1 + weight), opacity: 0.5, strokeDasharray: '6 4' };
  }
  if (kind === 'semantic') {
    return { stroke: meta.color, strokeWidth: 1.3, opacity: 0.45, strokeDasharray: '2 4' };
  }
  return { stroke: meta.color, strokeWidth: 1.6, opacity: 0.6 };
};

// Сколько рёбер каждого типа (для подписей фильтра). Ребро считается во все свои типы.
export const countEdgeKinds = (edges = []) => {
  const counts = { citation: 0, coupling: 0, semantic: 0 };
  edges.forEach((edge) => {
    getEdgeKinds(edge).forEach((kind) => {
      if (counts[kind] !== undefined) counts[kind] += 1;
    });
  });
  return counts;
};

export const positionNodesAroundAnchor = (existingNodes, newNodes, anchorId) => {
  const anchorNode = existingNodes.find((node) => node.id === anchorId);
  const anchorPosition = anchorNode?.position || { x: 0, y: 0 };
  const anchorCenter = {
    x: anchorPosition.x + 100,
    y: anchorPosition.y + 44,
  };

  const perRing = 8;

  return newNodes.map((node, index) => {
    const ring = Math.floor(index / perRing);
    const itemIndex = index % perRing;
    const itemsInRing = Math.min(perRing, newNodes.length - ring * perRing);
    const radius = 300 + ring * 190;
    const angleOffset = ring % 2 === 0 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / perRing;
    const angle = angleOffset + (2 * Math.PI * itemIndex) / Math.max(itemsInRing, 1);

    return {
      ...node,
      position: {
        x: anchorCenter.x + Math.cos(angle) * radius - 100,
        y: anchorCenter.y + Math.sin(angle) * radius - 44,
      },
    };
  });
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export const calculatePaperMetrics = (nodes = [], edges = []) => {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const degreeById = new Map(nodes.map((node) => [node.id, 0]));

  edges.forEach((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
    degreeById.set(edge.source, (degreeById.get(edge.source) || 0) + 1);
    degreeById.set(edge.target, (degreeById.get(edge.target) || 0) + 1);
  });

  const currentYear = new Date().getFullYear();
  const maxCitationLog = Math.max(
    1,
    ...nodes.map((node) => Math.log1p(Number(node.data?.citation_count || 0))),
  );
  const maxDegree = Math.max(1, ...Array.from(degreeById.values()));
  const maxRelevance = Math.max(
    1,
    ...nodes.map((node) => Number(node.data?.relevance_score || 0)),
  );

  return nodes.map((node) => {
    const citationCount = Number(node.data?.citation_count || 0);
    const degree = degreeById.get(node.id) || 0;
    const year = Number(node.data?.year || 0);
    const relevance = Number(node.data?.relevance_score || 0);

    const citationScore = Math.log1p(citationCount) / maxCitationLog;
    const centralityScore = degree / maxDegree;
    const recencyScore = year ? clamp01(1 - (currentYear - year) / 12) : 0;
    const relevanceScore = relevance / maxRelevance;
    const influenceScore = Math.round(
      100 * (
        0.45 * citationScore
        + 0.25 * centralityScore
        + 0.2 * recencyScore
        + 0.1 * relevanceScore
      ),
    );

    return {
      ...node,
      data: {
        ...node.data,
        citation_count: citationCount,
        graph_degree: degree,
        influence_score: influenceScore,
        metric_scores: {
          citations: Math.round(citationScore * 100),
          centrality: Math.round(centralityScore * 100),
          recency: Math.round(recencyScore * 100),
          relevance: Math.round(relevanceScore * 100),
        },
      },
    };
  });
};

export const getTimelineRange = (nodes = []) => {
  const yearCounts = new Map();

  nodes.forEach((node) => {
    const year = Number(node.data?.year || 0);
    if (!year) return;
    yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
  });

  const years = Array.from(yearCounts.keys()).sort((a, b) => a - b);
  if (years.length === 0) return null;

  return {
    min: years[0],
    max: years[years.length - 1],
    years,
    counts: yearCounts,
  };
};

export const filterGraphByYear = (nodes = [], edges = [], yearRange = null) => {
  if (!yearRange) return { nodes, edges };

  const range = typeof yearRange === 'object'
    ? yearRange
    : { from: null, to: yearRange };
  const fromYear = Number(range.from || 0);
  const toYear = Number(range.to || 0);

  const filteredNodes = nodes.filter((node) => {
    const year = Number(node.data?.year || 0);
    if (!year) return true;
    if (fromYear && year < fromYear) return false;
    if (toYear && year > toYear) return false;
    return true;
  });

  return {
    nodes: filteredNodes,
    edges: filterEdgesForNodes(edges, filteredNodes),
  };
};

export const getTopInfluentialPapers = (nodes = [], limit = 3) => (
  [...nodes]
    .filter((node) => node.data?.type === 'paper')
    .sort((a, b) => (b.data?.influence_score || 0) - (a.data?.influence_score || 0))
    .slice(0, limit)
);

export const buildResearchGaps = (nodes = [], edges = [], limit = 3) => {
  const clusters = new Map();
  const nodeToCluster = new Map();
  const years = nodes
    .map((node) => Number(node.data?.year || 0))
    .filter(Boolean);
  const maxYear = years.length ? Math.max(...years) : new Date().getFullYear();

  nodes.forEach((node) => {
    if (node.data?.type !== 'paper') return;
    const group = Number(node.data?.group || 0);
    const cluster = clusters.get(group) || {
      id: group,
      name: node.data?.group_name || `Кластер ${group + 1}`,
      nodes: [],
      recentCount: 0,
    };

    cluster.nodes.push(node);
    if (Number(node.data?.year || 0) >= maxYear - 3) {
      cluster.recentCount += 1;
    }

    clusters.set(group, cluster);
    nodeToCluster.set(node.id, group);
  });

  const clusterList = Array.from(clusters.values()).filter((cluster) => cluster.nodes.length > 0);
  if (clusterList.length < 2) return [];

  const crossEdges = new Map();
  edges.forEach((edge) => {
    const sourceCluster = nodeToCluster.get(edge.source);
    const targetCluster = nodeToCluster.get(edge.target);
    if (sourceCluster === undefined || targetCluster === undefined || sourceCluster === targetCluster) return;

    const key = [sourceCluster, targetCluster].sort((a, b) => a - b).join(':');
    crossEdges.set(key, (crossEdges.get(key) || 0) + 1);
  });

  const gaps = [];
  for (let i = 0; i < clusterList.length; i += 1) {
    for (let j = i + 1; j < clusterList.length; j += 1) {
      const left = clusterList[i];
      const right = clusterList[j];
      const key = [left.id, right.id].sort((a, b) => a - b).join(':');
      const edgeCount = crossEdges.get(key) || 0;
      const possibleEdges = Math.max(1, left.nodes.length * right.nodes.length);
      const connectionDensity = edgeCount / possibleEdges;
      const leftRecentShare = left.recentCount / left.nodes.length;
      const rightRecentShare = right.recentCount / right.nodes.length;
      const activityScore = (leftRecentShare + rightRecentShare) / 2;
      const balanceScore = Math.min(left.nodes.length, right.nodes.length) / Math.max(left.nodes.length, right.nodes.length);
      const gapScore = Math.round(100 * clamp01(
        0.55 * (1 - connectionDensity)
        + 0.3 * activityScore
        + 0.15 * balanceScore,
      ));

      gaps.push({
        id: `${left.id}-${right.id}`,
        left,
        right,
        edgeCount,
        gapScore,
        connectionDensity,
        description: `${left.name} + ${right.name}`,
      });
    }
  }

  return gaps
    .sort((a, b) => b.gapScore - a.gapScore)
    .slice(0, limit);
};

const getAuthorId = (author) => {
  const rawId = author?.id || author?.name || 'unknown';
  return `author:${String(rawId).trim().toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-')}`;
};

export const buildAuthorGraph = (paperNodes = []) => {
  const authorMap = new Map();
  const edgeMap = new Map();

  paperNodes.forEach((paperNode) => {
    const paperData = paperNode.data || {};
    const paperAuthors = (paperData.authors || [])
      .filter((author) => author?.name)
      .slice(0, 8);

    paperAuthors.forEach((author) => {
      const id = getAuthorId(author);
      if (!authorMap.has(id)) {
        authorMap.set(id, {
          id,
          data: {
            type: 'author',
            label: author.name,
            papers: [],
            years: new Set(),
          },
          position: { x: 0, y: 0 },
        });
      }

      const authorNode = authorMap.get(id);
      authorNode.data.papers.push({
        id: paperNode.id,
        title: paperData.label,
        year: paperData.year,
        url: paperData.url,
      });

      if (paperData.year) {
        authorNode.data.years.add(paperData.year);
      }
    });

    for (let i = 0; i < paperAuthors.length; i += 1) {
      for (let j = i + 1; j < paperAuthors.length; j += 1) {
        const source = getAuthorId(paperAuthors[i]);
        const target = getAuthorId(paperAuthors[j]);
        const [left, right] = [source, target].sort();
        const key = `${left}--${right}`;

        if (!edgeMap.has(key)) {
          edgeMap.set(key, {
            id: `author-edge-${left}-${right}`,
            source: left,
            target: right,
            data: {
              weight: 0,
              papers: [],
            },
          });
        }

        const edge = edgeMap.get(key);
        edge.data.weight += 1;
        edge.data.papers.push({
          id: paperNode.id,
          title: paperData.label,
        });
      }
    }
  });

  const nodes = Array.from(authorMap.values()).map((node, index) => {
    const papers = node.data.papers;
    const years = Array.from(node.data.years).sort((a, b) => a - b);

    return {
      ...node,
      data: {
        ...node.data,
        papers,
        paperCount: papers.length,
        years,
      },
      style: {
        width: 230,
        minHeight: 76,
        backgroundColor: AUTHOR_COLORS[index % AUTHOR_COLORS.length],
        borderRadius: 999,
        padding: 14,
        border: '1px solid #256d85',
        boxShadow: '0 10px 22px rgba(15, 23, 42, 0.12)',
        color: '#0f172a',
        fontSize: 13,
        lineHeight: 1.25,
      },
    };
  });

  const edges = Array.from(edgeMap.values()).map((edge) => ({
    ...edge,
    label: edge.data.weight > 1 ? String(edge.data.weight) : undefined,
    style: {
      stroke: '#64748b',
      strokeWidth: Math.min(5, 1 + edge.data.weight),
      opacity: 0.45,
    },
  }));

  return getLayoutedElements(nodes, filterEdgesForNodes(edges, nodes), 'LR');
};
