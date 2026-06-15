import { useState } from 'react';
import { EXPORT_FORMATS } from '../exportUtils';

const ExportMenu = ({ label = 'Экспорт', disabled = false, onSelect }) => {
  const [isOpen, setIsOpen] = useState(false);

  const handleSelect = (formatId) => {
    setIsOpen(false);
    onSelect(formatId);
  };

  return (
    <div className="export-menu">
      <button
        type="button"
        className="export-trigger"
        disabled={disabled}
        onClick={() => setIsOpen((value) => !value)}
      >
        {label}
      </button>

      {isOpen && !disabled && (
        <div className="export-options">
          {EXPORT_FORMATS.map((format) => (
            <button type="button" key={format.id} onClick={() => handleSelect(format.id)}>
              {format.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ExportMenu;
