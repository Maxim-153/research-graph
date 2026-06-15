import { useMemo, useState } from 'react';
import {
  DOWNLOAD_TYPES,
  EXPORT_FORMATS,
  buildExportContent,
  downloadTextFile,
  makeExportFilename,
} from '../exportUtils';

const copyToClipboard = async (text) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
};

const ExportDialog = ({ config, onClose }) => {
  const format = EXPORT_FORMATS.find((item) => item.id === config?.format) || EXPORT_FORMATS[0];
  const [downloadType, setDownloadType] = useState(format.downloadTypes[0]);
  const [copyState, setCopyState] = useState('Копировать');

  const content = useMemo(
    () => buildExportContent(config?.nodes || [], format.id),
    [config?.nodes, format.id],
  );

  if (!config) return null;

  const handleCopy = async () => {
    await copyToClipboard(content);
    setCopyState('Скопировано');
    window.setTimeout(() => setCopyState('Копировать'), 1400);
  };

  const handleDownload = () => {
    downloadTextFile(
      content,
      makeExportFilename(config.scopeLabel || 'graph', format.id),
      downloadType,
    );
  };

  return (
    <div className="export-backdrop" role="presentation" onClick={onClose}>
      <section className="export-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="export-dialog-head">
          <div>
            <span>{format.label}</span>
            <h2>{config.title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть">
            X
          </button>
        </header>

        <div className="export-meta">
          <span>{config.nodes.length} источников</span>
          <span>{config.scopeLabel}</span>
        </div>

        <textarea className="export-preview" value={content} readOnly />

        <footer className="export-dialog-actions">
          <button type="button" className="primary-action" onClick={handleCopy}>
            {copyState}
          </button>
          <select value={downloadType} onChange={(event) => setDownloadType(event.target.value)}>
            {format.downloadTypes.map((typeId) => (
              <option value={typeId} key={typeId}>
                {DOWNLOAD_TYPES[typeId].label}
              </option>
            ))}
          </select>
          <button type="button" className="secondary-action" onClick={handleDownload}>
            Скачать
          </button>
        </footer>
      </section>
    </div>
  );
};

export default ExportDialog;
