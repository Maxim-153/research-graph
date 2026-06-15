import { useCallback, useMemo, useState } from 'react';
import { applyEdgeChanges, applyNodeChanges } from 'reactflow';
import { fetchGraphData, expandGraphData } from './api';
import EdgeKindFilter from './components/EdgeKindFilter';
import ExportDialog from './components/ExportDialog';
import ExportMenu from './components/ExportMenu';
import GraphMap from './components/GraphMap';
import { getLayoutedElements } from './layoutUtils';
import Sidebar from './components/Sidebar';
import {
  GRAPH_MODES,
  buildAuthorGraph,
  buildResearchGaps,
  calculatePaperMetrics,
  countEdgeKinds,
  decoratePaperNode,
  dedupeNodes,
  filterEdgesByKind,
  filterEdgesForNodes,
  filterGraphByYear,
  getCitationEdges,
  getEdgeKindStyle,
  getNodeDedupeKey,
  getStructuralEdges,
  getTimelineRange,
  getTopInfluentialPapers,
  positionNodesAroundAnchor,
} from './graphUtils';
import { getConnectedPaperNodes, getPaperNodes } from './exportUtils';
import './App.css';

const getFullTimelineRange = (info) => (
  info ? { from: info.min, to: info.max } : null
);

const clampTimelineRange = (range, info) => {
  if (!info) return null;

  const from = Math.max(info.min, Math.min(Number(range?.from ?? info.min), info.max));
  const to = Math.min(info.max, Math.max(Number(range?.to ?? info.max), info.min));

  return from <= to ? { from, to } : { from: to, to: from };
};

// Русское согласование существительного с числом: 1 статья, 2 статьи, 5 статей.
const pluralizeRu = (count, one, few, many) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

function App() {
  const [searchQuery, setSearchQuery] = useState('');
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [sortMode, setSortMode] = useState('relevance');
  const [paperNodes, setPaperNodes] = useState([]);
  const [paperEdges, setPaperEdges] = useState([]);
  const [viewMode, setViewMode] = useState(GRAPH_MODES.PAPERS);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [expandedPaperIds, setExpandedPaperIds] = useState([]);
  const [timelineRange, setTimelineRange] = useState(null);
  // По умолчанию показываем только цитирование — чистый граф; сопряжение/семантику
  // пользователь включает сам в фильтре «Типы связей» на графе.
  const [edgeKinds, setEdgeKinds] = useState({ citation: true, coupling: false, semantic: false });
  const [rfInstance, setRfInstance] = useState(null);
  const [exportDialog, setExportDialog] = useState(null);
  // Курируемый список для экспорта: множество id отобранных публикаций.
  const [exportListIds, setExportListIds] = useState(() => new Set());
  // Вкладка области списка: 'all' — все результаты, 'export' — отобранная подборка.
  const [listTab, setListTab] = useState('all');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const timelineInfo = useMemo(() => getTimelineRange(paperNodes), [paperNodes]);
  const activeTimelineRange = useMemo(
    () => clampTimelineRange(timelineRange, timelineInfo),
    [timelineInfo, timelineRange],
  );
  const timelineGraph = useMemo(
    () => filterGraphByYear(paperNodes, paperEdges, activeTimelineRange),
    [paperNodes, paperEdges, activeTimelineRange],
  );
  const timelineSelectionStyle = useMemo(() => {
    if (!timelineInfo || !activeTimelineRange || timelineInfo.min === timelineInfo.max) {
      return { '--range-start': '0%', '--range-end': '100%' };
    }

    const span = timelineInfo.max - timelineInfo.min;
    return {
      '--range-start': `${((activeTimelineRange.from - timelineInfo.min) / span) * 100}%`,
      '--range-end': `${((activeTimelineRange.to - timelineInfo.min) / span) * 100}%`,
    };
  }, [activeTimelineRange, timelineInfo]);
  const authorGraph = useMemo(() => buildAuthorGraph(timelineGraph.nodes), [timelineGraph.nodes]);
  const isAuthorsMode = viewMode === GRAPH_MODES.AUTHORS;
  const edgeKindCounts = useMemo(() => countEdgeKinds(timelineGraph.edges), [timelineGraph.edges]);
  const visiblePaperEdges = useMemo(
    () => filterEdgesByKind(timelineGraph.edges, edgeKinds),
    [timelineGraph.edges, edgeKinds],
  );
  const topInfluentialPapers = useMemo(
    () => getTopInfluentialPapers(timelineGraph.nodes, 3),
    [timelineGraph.nodes],
  );
  // Research Gaps считаем по цитированиям — стабильная структура, не зависящая от
  // включённых семантических/библиографических слоёв в UI.
  const researchGaps = useMemo(
    () => buildResearchGaps(timelineGraph.nodes, getCitationEdges(timelineGraph.edges), 3),
    [timelineGraph.nodes, timelineGraph.edges],
  );

  const activeNodes = isAuthorsMode ? authorGraph.nodes : timelineGraph.nodes;
  const activeEdges = isAuthorsMode ? authorGraph.edges : visiblePaperEdges;
  const visiblePaperNodes = useMemo(() => getPaperNodes(timelineGraph.nodes), [timelineGraph.nodes]);
  const expandedPaperSet = useMemo(() => new Set(expandedPaperIds), [expandedPaperIds]);
  // Узлы подборки берём из полного набора статей (не из отфильтрованного по годам),
  // чтобы фильтр периода в UI не выбрасывал вручную добавленные публикации.
  const exportListNodes = useMemo(
    () => getPaperNodes(paperNodes).filter((node) => exportListIds.has(node.id)),
    [paperNodes, exportListIds],
  );

  const selectedNode = useMemo(
    () => activeNodes.find((node) => node.id === selectedNodeId) || null,
    [activeNodes, selectedNodeId],
  );

  const connectedNodeIds = useMemo(() => {
    if (!selectedNode) return null;

    const ids = new Set([selectedNode.id]);
    activeEdges.forEach((edge) => {
      if (edge.source === selectedNode.id) ids.add(edge.target);
      if (edge.target === selectedNode.id) ids.add(edge.source);
    });

    return ids;
  }, [activeEdges, selectedNode]);

  const localExportNodes = useMemo(
    () => getConnectedPaperNodes(selectedNode, timelineGraph.nodes, getCitationEdges(timelineGraph.edges)),
    [selectedNode, timelineGraph.nodes, timelineGraph.edges],
  );

  const selectedNodeExpanded = Boolean(selectedNode && expandedPaperSet.has(selectedNode.id));

  const handleTimelineRangeChange = (side, value) => {
    if (!timelineInfo) return;

    const year = Number(value);
    setSelectedNodeId(null);
    setTimelineRange((currentRange) => {
      const baseRange = clampTimelineRange(currentRange, timelineInfo) || getFullTimelineRange(timelineInfo);

      if (side === 'from') {
        return {
          from: Math.min(year, baseRange.to),
          to: baseRange.to,
        };
      }

      return {
        from: baseRange.from,
        to: Math.max(year, baseRange.from),
      };
    });
  };

  const handleNodesChange = useCallback((changes) => {
    if (viewMode !== GRAPH_MODES.PAPERS) return;
    setPaperNodes((currentNodes) => applyNodeChanges(changes, currentNodes));
  }, [viewMode]);

  const handleEdgesChange = useCallback((changes) => {
    if (viewMode !== GRAPH_MODES.PAPERS) return;
    setPaperEdges((currentEdges) => applyEdgeChanges(changes, currentEdges));
  }, [viewMode]);

  const displayNodes = useMemo(() => activeNodes.map((node) => {
    const isSelected = node.id === selectedNode?.id;
    const isConnected = connectedNodeIds?.has(node.id);
    // Узлы, добавленные в список экспорта, помечаем янтарным кольцом.
    const inList = !isAuthorsMode && exportListIds.has(node.id);

    return {
      ...node,
      style: {
        ...node.style,
        opacity: !selectedNode || isConnected ? 1 : 0.16,
        outline: isSelected ? '3px solid #0ea5e9' : 'none',
        boxShadow: inList ? '0 0 0 2px #f59e0b' : (node.style?.boxShadow || 'none'),
        transition: 'opacity 0.2s ease, outline 0.2s ease, box-shadow 0.2s ease',
      },
    };
  }), [activeNodes, connectedNodeIds, selectedNode, isAuthorsMode, exportListIds]);

  const displayEdges = useMemo(() => activeEdges.map((edge) => {
    const isConnected = selectedNode
      ? edge.source === selectedNode.id || edge.target === selectedNode.id
      : false;
    // Базовый стиль: у графа статей — по типу связи (цитирование/сопряжение/семантика),
    // у графа авторов — собственный стиль ребра.
    const baseStyle = isAuthorsMode ? (edge.style || {}) : getEdgeKindStyle(edge, edgeKinds);

    return {
      ...edge,
      hidden: selectedNode ? !isConnected : false,
      animated: Boolean(isConnected),
      style: {
        ...baseStyle,
        stroke: selectedNode ? (isConnected ? (baseStyle.stroke || '#0ea5e9') : '#334155') : (baseStyle.stroke || '#64748b'),
        strokeWidth: selectedNode ? (isConnected ? Math.max(baseStyle.strokeWidth || 1, 3) : 1) : (baseStyle.strokeWidth || 1.5),
        opacity: selectedNode ? (isConnected ? 1 : 0) : (baseStyle.opacity ?? 0.5),
        transition: 'opacity 0.2s ease, stroke-width 0.2s ease',
      },
    };
  }), [activeEdges, selectedNode, isAuthorsMode, edgeKinds]);

  const centerNode = (node) => {
    if (!rfInstance || !node?.position) return;

    rfInstance.setCenter(node.position.x + 100, node.position.y + 44, {
      zoom: 1.05,
      duration: 500,
    });
  };

  const handleSelectNode = (node) => {
    setSelectedNodeId(node.id);
    window.setTimeout(() => centerNode(node), 0);
  };

  const handlePaneClick = () => {
    setSelectedNodeId(null);
    // Клик по пустому месту — снимаем выбор и отдаляем камеру к общему виду графа,
    // чтобы не крутить колесо после каждого приближения к статье.
    window.setTimeout(() => rfInstance?.fitView({ padding: 0.18, duration: 500 }), 0);
  };

  const handleModeChange = (mode) => {
    setViewMode(mode);
    setSelectedNodeId(null);
    window.setTimeout(() => rfInstance?.fitView({ padding: 0.18, duration: 500 }), 80);
  };

  const toggleEdgeKind = (kind) => {
    setSelectedNodeId(null);
    setEdgeKinds((current) => ({ ...current, [kind]: !current[kind] }));
  };

  const handleSelectAuthorPaper = (paperId) => {
    const paperNode = timelineGraph.nodes.find((node) => node.id === paperId)
      || paperNodes.find((node) => node.id === paperId);

    if (!paperNode) {
      setError('Не удалось найти публикацию автора на текущем графе.');
      return;
    }

    setViewMode(GRAPH_MODES.PAPERS);
    setSelectedNodeId(paperNode.id);
    window.setTimeout(() => centerNode(paperNode), 80);
  };

  const isInExportList = (id) => exportListIds.has(id);

  const addToExportList = (ids) => {
    if (!ids?.length) return;
    setExportListIds((current) => {
      const next = new Set(current);
      ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggleExportItem = (id) => {
    setExportListIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const removeExportItem = (id) => {
    setExportListIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const clearExportList = () => setExportListIds(new Set());

  // β-наполнение списка: «всё показанное» и «выбранная статья со связями».
  const handleAddAllToList = () => addToExportList(visiblePaperNodes.map((node) => node.id));

  const handleAddConnectedToList = () => {
    if (selectedNode?.data?.type !== 'paper') return;
    addToExportList(localExportNodes.map((node) => node.id));
  };

  // Единственная точка выгрузки — отобранная подборка.
  const handleOpenListExport = (format) => {
    if (!exportListNodes.length) return;
    setExportDialog({
      title: 'Экспорт списка',
      scopeLabel: `подборка из ${exportListNodes.length}`,
      format,
      nodes: exportListNodes,
    });
  };

  // «Добавить все» работает тумблером: если всё показанное уже в списке —
  // повторный клик очищает подборку целиком.
  const allVisibleInList = visiblePaperNodes.length > 0
    && visiblePaperNodes.every((node) => exportListIds.has(node.id));

  const handleToggleAllInList = () => {
    if (allVisibleInList) clearExportList();
    else handleAddAllToList();
  };

  const handleSearch = async (event) => {
    event.preventDefault();
    if (!searchQuery.trim()) return;

    setIsLoading(true);
    setError(null);
    setSelectedNodeId(null);
    setExpandedPaperIds([]);
    setExportListIds(new Set());
    setListTab('all');

    try {
      const data = await fetchGraphData(searchQuery, yearFrom, yearTo, sortMode);
      if (data?.error) throw new Error(data.error);

      const fetchedNodes = dedupeNodes(data.nodes || []);
      if (fetchedNodes.length === 0) {
        setPaperNodes([]);
        setPaperEdges([]);
        setExpandedPaperIds([]);
        setTimelineRange(null);
        setError('По этому запросу ничего не найдено.');
        return;
      }

      const styledNodes = fetchedNodes.map((node) => decoratePaperNode({
        ...node,
        data: {
          ...node.data,
          origin: 'search',
        },
      }));
      const searchEdges = (data.edges || []).map((edge) => ({
        ...edge,
        data: {
          ...edge.data,
          origin: 'search',
        },
      }));
      const safeEdges = filterEdgesForNodes(searchEdges, styledNodes);
      // Раскладку Dagre строим по структурным рёбрам (цитирование + сопряжение),
      // а хранить и показывать будем все типы. Influence Score — только по цитированиям.
      const layouted = getLayoutedElements(styledNodes, getStructuralEdges(safeEdges));
      const scoredNodes = calculatePaperMetrics(layouted.nodes, getCitationEdges(safeEdges));
      const nextTimelineInfo = getTimelineRange(scoredNodes);

      setPaperNodes(scoredNodes);
      setPaperEdges(safeEdges);
      setTimelineRange(getFullTimelineRange(nextTimelineInfo));

      window.setTimeout(() => {
        // Открываем граф на читаемом зуме (не мельче 0.7), а не «впихиваем всё».
        rfInstance?.fitView({ padding: 0.15, minZoom: 0.7, duration: 700 });
      }, 120);
    } catch (err) {
      console.error(err);
      setError('Бэкенд недоступен или вернул ошибку. Проверьте терминал с uvicorn.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCollapse = (paperId) => {
    const remainingExpandedIds = expandedPaperIds.filter((id) => id !== paperId);
    const remainingExpandedSet = new Set(remainingExpandedIds);
    const remainingEdges = paperEdges.filter((edge) => edge.data?.expandedBy !== paperId);
    const connectedIds = new Set();

    remainingEdges.forEach((edge) => {
      connectedIds.add(edge.source);
      connectedIds.add(edge.target);
    });

    const remainingNodes = paperNodes.filter((node) => {
      if (node.data?.origin !== 'expanded') return true;
      return connectedIds.has(node.id) || remainingExpandedSet.has(node.id);
    });
    const safeEdges = filterEdgesForNodes(remainingEdges, remainingNodes);
    const scoredNodes = calculatePaperMetrics(remainingNodes, getCitationEdges(safeEdges));
    const nextTimelineInfo = getTimelineRange(scoredNodes);

    setPaperNodes(scoredNodes);
    setPaperEdges(safeEdges);
    setExpandedPaperIds(remainingExpandedIds);
    setTimelineRange((currentRange) => clampTimelineRange(currentRange, nextTimelineInfo));
    setSelectedNodeId(paperId);

    window.setTimeout(() => {
      rfInstance?.fitView({ padding: 0.18, duration: 500 });
    }, 80);
  };

  // Свернуть ВСЕ развёртки разом (двойной клик по пустому холсту): оставляем только
  // исходную выдачу поиска.
  const handleCollapseAll = () => {
    if (!expandedPaperIds.length) return;

    const searchNodes = paperNodes.filter((node) => node.data?.origin !== 'expanded');
    const searchEdges = paperEdges.filter((edge) => edge.data?.origin !== 'expanded');
    const safeEdges = filterEdgesForNodes(searchEdges, searchNodes);
    const scoredNodes = calculatePaperMetrics(searchNodes, getCitationEdges(safeEdges));
    const nextTimelineInfo = getTimelineRange(scoredNodes);

    setPaperNodes(scoredNodes);
    setPaperEdges(safeEdges);
    setExpandedPaperIds([]);
    setSelectedNodeId(null);
    setTimelineRange((currentRange) => clampTimelineRange(currentRange, nextTimelineInfo));

    window.setTimeout(() => {
      rfInstance?.fitView({ padding: 0.18, duration: 500 });
    }, 80);
  };

  const handleExpand = async (paperId) => {
    if (viewMode !== GRAPH_MODES.PAPERS) return;

    if (expandedPaperSet.has(paperId)) {
      handleCollapse(paperId);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const newData = await expandGraphData(paperId);
      if (newData?.error) throw new Error(newData.error);

      const fetchedNodes = dedupeNodes(newData.nodes || []);
      const fetchedEdges = newData.edges || [];
      const existingNodeIds = new Set(paperNodes.map((node) => node.id));
      const existingNodeKeys = new Set(paperNodes.map(getNodeDedupeKey).filter(Boolean));
      const existingEdgeKeys = new Set(paperEdges.map((edge) => `${edge.source}->${edge.target}`));

      const uniqueNewNodes = fetchedNodes
        .filter((node) => (
          node?.id
          && !existingNodeIds.has(node.id)
          && !existingNodeKeys.has(getNodeDedupeKey(node))
        ))
        .map((node) => decoratePaperNode({
          ...node,
          data: {
            ...node.data,
            origin: 'expanded',
            expandedBy: paperId,
          },
        }, { isNew: true }));

      const positionedNewNodes = positionNodesAroundAnchor(paperNodes, uniqueNewNodes, paperId);
      const combinedNodes = dedupeNodes([...paperNodes, ...positionedNewNodes]);
      const scopedFetchedEdges = fetchedEdges.map((edge) => ({
        ...edge,
        data: {
          ...edge.data,
          origin: 'expanded',
          expandedBy: paperId,
        },
      }));
      const combinedEdges = filterEdgesForNodes([...paperEdges, ...scopedFetchedEdges], combinedNodes);
      const scoredCombinedNodes = calculatePaperMetrics(combinedNodes, getCitationEdges(combinedEdges));
      const nextTimelineInfo = getTimelineRange(scoredCombinedNodes);
      const addedEdgeCount = combinedEdges
        .filter((edge) => !existingEdgeKeys.has(`${edge.source}->${edge.target}`))
        .length;

      if (positionedNewNodes.length === 0 && addedEdgeCount === 0) {
        setError('Новых связей для этой статьи не найдено.');
        return;
      }

      setPaperNodes(scoredCombinedNodes);
      setPaperEdges(combinedEdges);
      setSelectedNodeId(paperId);
      setExpandedPaperIds((currentIds) => (
        currentIds.includes(paperId) ? currentIds : [...currentIds, paperId]
      ));
      setTimelineRange((currentRange) => clampTimelineRange(currentRange, nextTimelineInfo));

      const anchorNode = paperNodes.find((node) => node.id === paperId);
      window.setTimeout(() => {
        if (anchorNode) {
          rfInstance?.setCenter(anchorNode.position.x + 100, anchorNode.position.y + 44, {
            zoom: 0.78,
            duration: 650,
          });
        }
      }, 120);
    } catch (err) {
      console.error('Ошибка при расширении графа:', err);
      setError('Не удалось загрузить связи. Проверьте терминал с uvicorn.');
    } finally {
      setIsLoading(false);
    }
  };

  const renderListMeta = (node) => {
    if (node.data.type === 'author') {
      const years = node.data.years?.length
        ? `${node.data.years[0]}-${node.data.years[node.data.years.length - 1]}`
        : 'годы не указаны';
      return `${node.data.paperCount} ${pluralizeRu(node.data.paperCount, 'статья', 'статьи', 'статей')} · ${years}`;
    }

    const influence = node.data.influence_score !== undefined
      ? ` · влияние ${node.data.influence_score}/100`
      : '';
    return `${node.data.year || 'год не указан'} · ${node.data.group_name || 'без кластера'}${influence}`;
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div>
            <h1>Карта научных публикаций</h1>
          </div>
        </div>

        <form className="search-form" onSubmit={handleSearch}>
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Введите тему исследования"
          />
          <input
            type="number"
            value={yearFrom}
            onChange={(event) => setYearFrom(event.target.value)}
            placeholder="От"
          />
          <input
            type="number"
            value={yearTo}
            onChange={(event) => setYearTo(event.target.value)}
            placeholder="До"
          />
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value)}
            aria-label="Сортировка статей"
          >
            <option value="relevance">Релевантные</option>
            <option value="newest">Сначала новые</option>
            <option value="cited">Сначала цитируемые</option>
          </select>
          <button type="submit" disabled={isLoading}>
            {isLoading ? 'Ищем...' : 'Построить'}
          </button>
        </form>

        <div className="mode-switch" role="tablist" aria-label="Режим графа">
          <button
            type="button"
            className={viewMode === GRAPH_MODES.PAPERS ? 'active' : ''}
            onClick={() => handleModeChange(GRAPH_MODES.PAPERS)}
          >
            Статьи
          </button>
          <button
            type="button"
            className={viewMode === GRAPH_MODES.AUTHORS ? 'active' : ''}
            onClick={() => handleModeChange(GRAPH_MODES.AUTHORS)}
          >
            Авторы
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="results-panel">
          <div className="results-head">
            <div>
              <h2>{viewMode === GRAPH_MODES.AUTHORS ? 'Авторы' : 'Статьи'}</h2>
              <p>{activeNodes.length} {isAuthorsMode ? pluralizeRu(activeNodes.length, 'автор', 'автора', 'авторов') : `${pluralizeRu(activeNodes.length, 'узел', 'узла', 'узлов')} на графе`}</p>
            </div>
            {paperNodes.length > 0 && (
              <div className="results-head-actions">
                <button type="button" onClick={() => rfInstance?.fitView({ padding: 0.18, duration: 500 })}>
                  Весь граф
                </button>
                {!isAuthorsMode && (
                  <button type="button" onClick={handleToggleAllInList} disabled={!visiblePaperNodes.length}>
                    {allVisibleInList ? 'Очистить список' : 'Добавить все в список'}
                  </button>
                )}
                {!isAuthorsMode && (
                  <ExportMenu
                    label={`Экспорт списка${exportListNodes.length ? ` (${exportListNodes.length})` : ''}`}
                    onSelect={handleOpenListExport}
                    disabled={!exportListNodes.length}
                  />
                )}
              </div>
            )}
          </div>

          {paperNodes.length > 0 && (
            <div className="analysis-panel">
              {timelineInfo && (
                <section className="analysis-section">
                  <div className="analysis-title">
                    <span>Период публикаций</span>
                    <strong>
                      {activeTimelineRange?.from || timelineInfo.min}-{activeTimelineRange?.to || timelineInfo.max}
                    </strong>
                  </div>
                  <div className="range-slider" style={timelineSelectionStyle}>
                    <input
                      className="range-input range-input-from"
                      type="range"
                      min={timelineInfo.min}
                      max={timelineInfo.max}
                      value={activeTimelineRange?.from || timelineInfo.min}
                      onChange={(event) => handleTimelineRangeChange('from', event.target.value)}
                      aria-label="Начало периода"
                    />
                    <input
                      className="range-input range-input-to"
                      type="range"
                      min={timelineInfo.min}
                      max={timelineInfo.max}
                      value={activeTimelineRange?.to || timelineInfo.max}
                      onChange={(event) => handleTimelineRangeChange('to', event.target.value)}
                      aria-label="Конец периода"
                    />
                  </div>
                  <div className="timeline-meta">
                    <span>{timelineInfo.min}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedNodeId(null);
                        setTimelineRange(getFullTimelineRange(timelineInfo));
                      }}
                    >
                      Все годы
                    </button>
                    <span>{timelineInfo.max}</span>
                  </div>
                </section>
              )}

              <section className="analysis-section">
                <div className="analysis-title">
                  <span>Ключевые статьи</span>
                  <strong>влияние</strong>
                </div>
                <div className="mini-list">
                  {topInfluentialPapers.map((node) => (
                    <button type="button" key={node.id} onClick={() => handleSelectNode(node)}>
                      <span>{node.data.label}</span>
                      <strong>{node.data.influence_score}/100</strong>
                    </button>
                  ))}
                </div>
              </section>

              <section className="analysis-section">
                <div className="analysis-title">
                  <span>Слабые связи тем</span>
                  <strong>{researchGaps.length}</strong>
                </div>
                <div className="gap-list">
                  {researchGaps.length === 0 ? (
                    <p>Нужно минимум два кластера.</p>
                  ) : researchGaps.map((gap) => (
                    <div className="gap-item" key={gap.id}>
                      <span>{gap.description}</span>
                      <strong>{gap.gapScore}/100</strong>
                      <small>Связей между кластерами: {gap.edgeCount}</small>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {isAuthorsMode ? (
            <div className="results-list">
              {activeNodes.length === 0 ? (
                <div className="empty-list">Нет данных</div>
              ) : activeNodes.map((node) => (
                <button
                  type="button"
                  key={node.id}
                  className={`result-item ${selectedNodeId === node.id ? 'selected' : ''}`}
                  onClick={() => handleSelectNode(node)}
                >
                  <span className="result-title">{node.data.label}</span>
                  <span className="result-meta">{renderListMeta(node)}</span>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="list-tabs" role="tablist">
                <button
                  type="button"
                  className={listTab === 'all' ? 'active' : ''}
                  onClick={() => setListTab('all')}
                >
                  Все статьи ({activeNodes.length})
                </button>
                <button
                  type="button"
                  className={listTab === 'export' ? 'active' : ''}
                  onClick={() => setListTab('export')}
                >
                  Список ({exportListNodes.length})
                </button>
              </div>

              {listTab === 'all' ? (
                <div className="results-list">
                  {activeNodes.length === 0 ? (
                    <div className="empty-list">Нет данных</div>
                  ) : activeNodes.map((node) => (
                    <div key={node.id} className="result-item-row">
                      <button
                        type="button"
                        className={`result-item ${selectedNodeId === node.id ? 'selected' : ''}`}
                        onClick={() => handleSelectNode(node)}
                      >
                        <span className="result-title">{node.data.label}</span>
                        <span className="result-meta">{renderListMeta(node)}</span>
                      </button>
                      <button
                        type="button"
                        className={`result-star ${isInExportList(node.id) ? 'on' : ''}`}
                        onClick={() => toggleExportItem(node.id)}
                        title={isInExportList(node.id) ? 'Убрать из списка' : 'Добавить в список'}
                        aria-label="Добавить в список"
                      >
                        {isInExportList(node.id) ? '★' : '☆'}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="results-list">
                  {exportListNodes.length === 0 ? (
                    <div className="empty-list">
                      Отметьте статьи звёздочкой во вкладке «Все статьи» или кнопкой «В список» в карточке.
                    </div>
                  ) : (
                    <>
                      <div className="export-list-actions">
                        <ExportMenu
                          label="Экспортировать список"
                          onSelect={handleOpenListExport}
                          disabled={!exportListNodes.length}
                        />
                        <button type="button" className="ghost-action" onClick={clearExportList}>
                          Очистить
                        </button>
                      </div>
                      {exportListNodes.map((node) => (
                        <div key={node.id} className="export-list-item">
                          <button
                            type="button"
                            className={`result-item ${selectedNodeId === node.id ? 'selected' : ''}`}
                            onClick={() => handleSelectNode(node)}
                          >
                            <span className="result-title">{node.data.label}</span>
                            <span className="result-meta">{renderListMeta(node)}</span>
                          </button>
                          <button
                            type="button"
                            className="export-list-remove"
                            onClick={() => removeExportItem(node.id)}
                            title="Убрать из списка"
                            aria-label="Убрать из списка"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </aside>

        <section className="graph-stage">
          {activeNodes.length > 0 ? (
            <GraphMap
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onNodeClick={(event, node) => handleSelectNode(node)}
              onNodeDoubleClick={(event, node) => {
                if (node.data.type === 'paper') handleExpand(node.id);
              }}
              onPaneClick={handlePaneClick}
              onPaneDoubleClick={handleCollapseAll}
              onInit={setRfInstance}
            >
              {!isAuthorsMode && (
                <EdgeKindFilter
                  edgeKinds={edgeKinds}
                  counts={edgeKindCounts}
                  onToggle={toggleEdgeKind}
                />
              )}
            </GraphMap>
          ) : (
            <div className="empty-graph">
              <h2>Граф появится здесь</h2>
              <p>Ожидание данных OpenAlex.</p>
            </div>
          )}

          {isLoading && (
            <div className="loading-overlay">
              <div className="loader" />
              <span>Загрузка данных</span>
            </div>
          )}

          {error && (
            <div className="status-message">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)}>Закрыть</button>
            </div>
          )}

          <Sidebar
            key={selectedNode?.id || 'empty'}
            node={selectedNode}
            onClose={handlePaneClick}
            onExpand={handleExpand}
            isExpanded={selectedNodeExpanded}
            onToggleList={toggleExportItem}
            onAddConnected={handleAddConnectedToList}
            isInList={Boolean(selectedNode && isInExportList(selectedNode.id))}
            onSelectPaper={handleSelectAuthorPaper}
          />
        </section>
      </main>

      <ExportDialog config={exportDialog} onClose={() => setExportDialog(null)} />
    </div>
  );
}

export default App;
