import { useState } from 'react';

// Выходные данные публикации для карточки. Поля приходят с сервера в node.data
// (те же, что использует экспорт); пустые могут быть null — пропускаем их, чтобы
// в карточке не возникало «Т. null».
const formatVolumeIssue = (volume, issue) => [
  volume ? `Т. ${volume}` : '',
  issue ? `№ ${issue}` : '',
].filter(Boolean).join(', ');

const formatPagesShort = (first, last) => {
  if (first && last && first !== last) return `С. ${first}–${last}`;
  if (first || last) return `С. ${first || last}`;
  return '';
};

// Состояние «показать публикации автора» сбрасывается само при смене выбранной
// карточки: родитель передаёт key={node.id}, поэтому компонент перемонтируется.
const Sidebar = ({ node, onClose, onExpand, isExpanded = false, onToggleList, onAddConnected, isInList = false, onSelectPaper }) => {
  const [showAuthorPapers, setShowAuthorPapers] = useState(false);

  const isOpen = Boolean(node);

  if (!isOpen) {
    return <aside className="details-drawer" aria-hidden="true" />;
  }

  const isAuthor = node.data.type === 'author';
  const authorsText = node.data.authors && node.data.authors.length > 0
    ? node.data.authors.map((author) => author.name).join(', ')
    : 'Неизвестно';
  const yearsText = node.data.years?.length
    ? `${node.data.years[0]}-${node.data.years[node.data.years.length - 1]}`
    : 'Нет данных';

  return (
    <aside className="details-drawer open">
      <div className="drawer-head">
        <div>
          <span className="drawer-kicker">{isAuthor ? 'Автор' : 'Статья'}</span>
          <h2>{node.data.label}</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть">
          X
        </button>
      </div>

      {!isAuthor && (
        <div className="drawer-listbar">
          <button
            type="button"
            className={`list-chip ${isInList ? 'on' : ''}`}
            onClick={() => onToggleList?.(node.id)}
            title={isInList ? 'Убрать из списка' : 'Добавить в список'}
          >
            {isInList ? '★ В списке' : '☆ Добавить в список'}
          </button>
        </div>
      )}

      {isAuthor ? (
        <>
          <div className="info-grid">
            <div>
              <span>Публикаций</span>
              <strong>{node.data.paperCount}</strong>
            </div>
            <div>
              <span>Годы</span>
              <strong>{yearsText}</strong>
            </div>
          </div>

          <div className="drawer-actions author-actions">
            <button
              type="button"
              className="secondary-action"
              onClick={() => setShowAuthorPapers((value) => !value)}
            >
              {showAuthorPapers ? 'Скрыть публикации' : 'Показать публикации'}
            </button>
          </div>

          {showAuthorPapers && (
          <section className="drawer-section">
            <h3>Статьи автора</h3>
            <div className="paper-stack">
              {node.data.papers.map((paper) => {
                const content = (
                  <>
                    <span>{paper.title}</span>
                    <small>{paper.year || 'год не указан'}</small>
                  </>
                );

                return (
                  <button
                    type="button"
                    key={paper.id}
                    className="paper-link paper-link-button"
                    onClick={() => onSelectPaper?.(paper.id)}
                  >
                    {content}
                  </button>
                );
              })}
            </div>
          </section>
          )}
        </>
      ) : (
        <>
          <div className="info-grid">
            <div>
              <span>Год</span>
              <strong>{node.data.year || 'Нет данных'}</strong>
            </div>
            <div>
              <span>Кластер</span>
              <strong>{node.data.group_name || 'Без группы'}</strong>
            </div>
            <div>
              <span>Влияние</span>
              <strong>{node.data.influence_score ?? 0}/100</strong>
            </div>
            <div>
              <span>Цитирований</span>
              <strong>{node.data.citation_count ?? 0}</strong>
            </div>
          </div>

          {(node.data.source || node.data.volume || node.data.issue
            || node.data.first_page || node.data.last_page) && (
            <section className="drawer-section">
              <h3>Выходные данные</h3>
              <p>
                {[
                  node.data.source,
                  formatVolumeIssue(node.data.volume, node.data.issue),
                  formatPagesShort(node.data.first_page, node.data.last_page),
                ].filter(Boolean).join('. ')}
              </p>
            </section>
          )}

          {node.data.metric_scores && (
            <section className="drawer-section">
              <h3>Формула влияния</h3>
              <div className="metric-bars">
                <div>
                  <span>Цитирования</span>
                  <strong>{node.data.metric_scores.citations}%</strong>
                </div>
                <div>
                  <span>Центральность</span>
                  <strong>{node.data.metric_scores.centrality}%</strong>
                </div>
                <div>
                  <span>Новизна</span>
                  <strong>{node.data.metric_scores.recency}%</strong>
                </div>
                <div>
                  <span>Релевантность</span>
                  <strong>{node.data.metric_scores.relevance}%</strong>
                </div>
              </div>
            </section>
          )}

          <section className="drawer-section">
            <h3>Авторы</h3>
            <p>{authorsText}</p>
          </section>

          <div className="drawer-actions">
            {node.data.url && (
              <a href={node.data.url} target="_blank" rel="noopener noreferrer" className="primary-action">
                Читать оригинал
              </a>
            )}
            <button type="button" className="secondary-action" onClick={() => onExpand(node.id)}>
              {isExpanded ? 'Скрыть связи' : 'Развернуть связи'}
            </button>
            <button type="button" className="secondary-action" onClick={() => onAddConnected?.(node.id)}>
              Добавить со связями
            </button>
          </div>

          <section className="drawer-section">
            <h3>Аннотация</h3>
            <p>{node.data.abstract || 'Аннотация отсутствует для данной статьи.'}</p>
          </section>
        </>
      )}
    </aside>
  );
};

export default Sidebar;
