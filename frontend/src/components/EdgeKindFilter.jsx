import { EDGE_KIND_META } from '../graphUtils';
import './EdgeKindFilter.css';

const LineSample = ({ color, dash }) => (
  <svg width="26" height="10" aria-hidden="true" className="edge-kind-row__line">
    <line
      x1="1"
      y1="5"
      x2="25"
      y2="5"
      stroke={color}
      strokeWidth="2.5"
      strokeDasharray={dash || undefined}
      strokeLinecap="round"
    />
  </svg>
);

// Легенда-фильтр типов связей на графе: чип-переключатель + образец линии + «?» с
// пояснением при наведении. Видим только в режиме статей.
const EdgeKindFilter = ({ edgeKinds, counts = {}, onToggle }) => (
  <div className="edge-kind-filter">
    <div className="edge-kind-filter__title">Типы связей</div>
    {Object.entries(EDGE_KIND_META).map(([kind, meta]) => {
      const count = counts[kind] || 0;
      const on = Boolean(edgeKinds?.[kind]) && count > 0;
      return (
        <button
          type="button"
          key={kind}
          className={`edge-kind-row ${on ? 'is-on' : ''}`}
          onClick={() => count && onToggle(kind)}
          disabled={!count}
        >
          <span
            className="edge-kind-row__check"
            style={{ borderColor: meta.color, background: on ? meta.color : 'transparent' }}
          />
          <LineSample color={meta.color} dash={meta.dash} />
          <span className="edge-kind-row__label">{meta.label}</span>
          <span className="edge-kind-row__count">{count}</span>
          <span
            className="edge-kind-row__help"
            title={meta.desc}
            role="img"
            aria-label={meta.desc}
            onClick={(event) => event.stopPropagation()}
          >
            ?
          </span>
        </button>
      );
    })}
  </div>
);

export default EdgeKindFilter;
