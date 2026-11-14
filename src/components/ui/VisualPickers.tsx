import React, { useState } from 'react';
import {
  CURATED_COLOR_PALETTE,
  VISUAL_ICON_OPTIONS,
  VisualColorOption,
  VisualIconOption,
  resolveHexColor,
  resolvePhosphorCategoryIcon,
} from '../../utils/visualPickerUtils';

export {
  CURATED_COLOR_PALETTE,
  VISUAL_ICON_OPTIONS,
  SPACE_ICON_OPTIONS,
  resolveHexColor,
  resolvePhosphorCategoryIcon,
  resolveColorTokenFromValue,
} from '../../utils/visualPickerUtils';

interface IconGridPickerProps {
  label?: string;
  value: string;
  onChange: (iconId: string) => void;
  options?: VisualIconOption[];
  disabled?: boolean;
  compact?: boolean;
}

export const IconGridPicker: React.FC<IconGridPickerProps> = ({
  label = 'Ícone',
  value,
  onChange,
  options = VISUAL_ICON_OPTIONS,
  disabled = false,
  compact = false,
}) => {
  const resolvedValue = resolvePhosphorCategoryIcon(value);

  return (
    <div className="space-y-2">
      {label && (
        <div className="flex items-center justify-between">
          <span className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
            {label}
          </span>
          <span className="text-[11px] text-slate-400">
            {options.find((o) => o.phosphorClass === resolvedValue)?.label || 'Personalizado'}
          </span>
        </div>
      )}

      <div
        role="radiogroup"
        aria-label={label}
        className={`grid ${
          compact ? 'grid-cols-6 sm:grid-cols-8' : 'grid-cols-6 sm:grid-cols-8'
        } gap-1.5 p-2 rounded-xl bg-slate-900/90 border border-slate-700/80`}
      >
        {options.map((opt) => {
          const isSelected = resolvedValue === opt.phosphorClass;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={opt.label}
              title={opt.label}
              disabled={disabled}
              onClick={() => onChange(opt.id)}
              className={`h-9 rounded-lg flex items-center justify-center transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                isSelected
                  ? 'bg-indigo-600/25 border-2 border-indigo-400 text-indigo-200 shadow-xs scale-105'
                  : 'bg-slate-800/80 border border-slate-700/80 text-slate-400 hover:text-white hover:border-slate-500 hover:bg-slate-800'
              }`}
            >
              <i className={`ph-fill ${opt.phosphorClass} text-base`} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
};

interface ColorPalettePickerProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  mode?: 'hex' | 'token';
  palette?: VisualColorOption[];
  allowCustomHex?: boolean;
  disabled?: boolean;
}

export const ColorPalettePicker: React.FC<ColorPalettePickerProps> = ({
  label = 'Cor',
  value,
  onChange,
  mode = 'hex',
  palette = CURATED_COLOR_PALETTE,
  allowCustomHex = true,
  disabled = false,
}) => {
  const activeHex = resolveHexColor(value);
  const isInPalette = palette.some(
    (c) => c.hex.toUpperCase() === activeHex.toUpperCase() || c.id === value
  );
  const [showCustomPicker, setShowCustomPicker] = useState(
    Boolean(allowCustomHex && value && !isInPalette)
  );

  return (
    <div className="space-y-2">
      {label && (
        <div className="flex items-center justify-between gap-2">
          <span className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
            {label}
          </span>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
            <span
              className="w-3 h-3 rounded-full border border-white/20 inline-block"
              style={{ backgroundColor: activeHex }}
            />
            {activeHex}
          </span>
        </div>
      )}

      <div
        role="radiogroup"
        aria-label={label}
        className="flex flex-wrap items-center gap-2 p-2.5 rounded-xl bg-slate-900/90 border border-slate-700/80"
      >
        {palette.map((color) => {
          const isSelected =
            (mode === 'token' && (value === color.id || activeHex === color.hex.toUpperCase())) ||
            (mode === 'hex' && activeHex === color.hex.toUpperCase());

          return (
            <button
              key={color.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={`Cor ${color.label}`}
              title={color.label}
              disabled={disabled}
              onClick={() => {
                onChange(mode === 'token' ? color.id : color.hex);
                setShowCustomPicker(false);
              }}
              className={`w-7 h-7 rounded-full flex items-center justify-center transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                isSelected
                  ? 'ring-2 ring-white ring-offset-2 ring-offset-slate-900 scale-110'
                  : 'opacity-85 hover:opacity-100 hover:scale-105'
              }`}
              style={{ backgroundColor: color.hex }}
            >
              {isSelected && (
                <i className="ph-bold ph-check text-[11px] text-white drop-shadow" aria-hidden="true" />
              )}
            </button>
          );
        })}

        {allowCustomHex && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setShowCustomPicker((prev) => !prev)}
            className="ml-auto px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-semibold text-slate-300 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            {showCustomPicker ? 'Ocultar seletor' : 'Escolher outra cor'}
          </button>
        )}
      </div>

      {allowCustomHex && showCustomPicker && (
        <div className="flex items-center gap-3 p-2.5 rounded-xl bg-slate-800/80 border border-slate-700/80">
          <input
            type="color"
            disabled={disabled}
            value={activeHex}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            aria-label="Selecionar cor personalizada"
            className="w-9 h-9 rounded-lg cursor-pointer border border-slate-600 bg-slate-900 p-0.5"
          />
          <div className="text-xs text-slate-300">
            <span className="block font-semibold">Cor personalizada</span>
            <span className="font-mono text-[11px] text-slate-400">{activeHex}</span>
          </div>
        </div>
      )}
    </div>
  );
};
