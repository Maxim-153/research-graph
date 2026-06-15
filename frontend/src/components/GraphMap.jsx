import ReactFlow, { Background, Controls, MiniMap, Panel } from 'reactflow';
import 'reactflow/dist/style.css'; // Обязательные стили

const GraphMap = ({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onNodeClick,
  onNodeDoubleClick,
  onPaneClick,
  onPaneDoubleClick,
  onInit,
  children,
}) => {
  // Двойной клик по пустому холсту (а не по карточке) — у ReactFlow нет
  // отдельного onPaneDoubleClick, поэтому ловим на обёртке по классу пустой области.
  const handleDoubleClick = (event) => {
    if (event.target?.classList?.contains('react-flow__pane')) {
      onPaneDoubleClick?.();
    }
  };

  return (
    <div className="graph-map" onDoubleClick={handleDoubleClick}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onInit={onInit}
        fitView // Автоматически центрирует камеру при загрузке
        // minZoom: не мельчим ниже читаемого — лучше панорама, чем нечитаемые карточки.
        fitViewOptions={{ padding: 0.15, minZoom: 0.7 }}
        nodesDraggable={true} // Разрешаем двигать карточки
        nodesConnectable={false}
        minZoom={0.18}
        maxZoom={1.8}
        theme="dark"
      >
        <Background color="#444" gap={16} />
        <Controls />
        {children && <Panel position="top-right">{children}</Panel>}
        {/* Мини-карта: учитывает режим фокуса (погашенные узлы — серым) */}
        <MiniMap 
          nodeColor={(node) => {
            // Погашенный фокусом узел (opacity < 1) — тёмно-серым, чтобы не отвлекал.
            if (node.style?.opacity && node.style.opacity < 1) return '#2a2a2a';
            
            // Иначе — цвет тематического кластера (или синий по умолчанию).
            return node.style?.backgroundColor || '#007bff';
          }}
          maskColor="rgba(0, 0, 0, 0.5)" 
          style={{ backgroundColor: '#1e1e1e' }} 
        />
      </ReactFlow>
    </div>
  );
};

export default GraphMap;
