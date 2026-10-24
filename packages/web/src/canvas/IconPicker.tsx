/**
 * Choosing an icon for the selected nodes: one of Lucide's, found by name or
 * by what it shows, or a custom SVG, uploaded, pasted, or one the canvas
 * already has.
 *
 * A new SVG is sanitised here with the same code the server runs, so what the
 * preview shows is exactly what will be stored; the server sanitises it again
 * on the way in, and its copy is the one that counts.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  SVG_LIMITS,
  STYLE_LIMITS,
  sanitizeSvg,
  svgDataUri,
  SvgError,
  type CanvasAsset,
  type CanvasIcon,
  type CanvasIconPosition,
} from '@open-artifact/shared';
import { Button, Dialog, TextInput } from '../components/primitives.js';
import { paint } from './look.js';
import { ICON_SIZE, LucideGlyph, loadLucide, loadLucideTags, type LucideSet } from './icons.js';

/**
 * What the picker hands back: an icon the canvas can already draw, or a new SVG
 * to add to the canvas and the icon settings to show it with.
 */
export type IconChoice =
  | { icon: CanvasIcon; asset?: undefined }
  | { icon: Omit<CanvasIcon, 'name'>; asset: { svg: string; name?: string } };

const SHOWN = 120;

export function IconPicker({
  assets,
  current,
  onClose,
  onChoose,
}: {
  assets: Record<string, CanvasAsset> | undefined;
  current: CanvasIcon | undefined;
  onClose: () => void;
  onChoose: (choice: IconChoice) => void;
}) {
  const [tab, setTab] = useState<'lucide' | 'svg'>(current?.name.startsWith('asset:') ? 'svg' : 'lucide');
  const [name, setName] = useState<string | null>(current?.name ?? null);
  const [position, setPosition] = useState<CanvasIconPosition>(current?.position ?? 'left');
  const [size, setSize] = useState<number | undefined>(current?.size);
  const [color, setColor] = useState<string>(current?.color ?? '');
  const [fresh, setFresh] = useState<{ svg: string; name?: string } | null>(null);

  const chosen: IconChoice | null = (() => {
    const settings = { position, ...(size !== undefined ? { size } : {}) };
    if (name === 'new') return fresh ? { icon: settings, asset: fresh } : null;
    if (!name) return null;
    return { icon: { name, ...settings, ...(name.startsWith('lucide:') && color ? { color } : {}) } };
  })();

  return (
    <Dialog
      open
      onClose={onClose}
      title="Icon"
      description="Shown on every selected node."
      width={560}
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={!chosen} onClick={() => chosen && onChoose(chosen)} data-testid="icon-apply">
            Use icon
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="icon-picker">
        <div className="flex gap-1 border-b border-line" role="tablist">
          {(
            [
              ['lucide', 'Lucide icons'],
              ['svg', 'Custom SVG'],
            ] as const
          ).map(([id, text]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`-mb-px border-b-2 px-2 pb-1.5 text-[12.5px] ${tab === id ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
              onClick={() => setTab(id)}
            >
              {text}
            </button>
          ))}
        </div>
        {tab === 'lucide' ? (
          <LucideTab chosen={name} onPick={setName} colour={color ? paint(color) : 'var(--color-ink)'} />
        ) : (
          <SvgTab
            assets={assets}
            chosen={name}
            fresh={fresh}
            onPick={setName}
            onFresh={(asset) => {
              setFresh(asset);
              setName(asset ? 'new' : null);
            }}
          />
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3 text-[12.5px]">
          <span className="text-ink-2">Position</span>
          <div className="flex rounded-[--radius-sm] border border-line p-0.5" role="group" aria-label="Icon position">
            {(['left', 'top'] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={position === p}
                className={`h-6 rounded-[4px] px-2 text-[12px] ${position === p ? 'bg-accent-wash font-medium text-accent' : 'text-ink-2 hover:bg-sunken'}`}
                onClick={() => setPosition(p)}
              >
                {p === 'left' ? 'Beside text' : 'Above text'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-ink-2">
            Size
            <input
              type="number"
              min={12}
              max={160}
              className="h-7 w-16 rounded-[--radius-sm] border border-line bg-surface px-1.5 text-[12px] text-ink"
              placeholder={String(ICON_SIZE[position])}
              value={size ?? ''}
              aria-label="Icon size"
              onChange={(event) => {
                const value = event.target.value === '' ? undefined : Math.min(160, Math.max(12, Math.round(Number(event.target.value))));
                setSize(Number.isFinite(value) ? value : undefined);
              }}
            />
            px
          </label>
          {tab === 'lucide' && (
            <label className="flex items-center gap-1.5 text-ink-2">
              Colour
              <input
                type="color"
                className="h-7 w-9 cursor-pointer rounded border border-line bg-surface p-0.5"
                value={color && color.startsWith('#') && color.length === 7 ? color : '#3f3f46'}
                aria-label="Icon colour"
                onChange={(event) => setColor(event.target.value)}
              />
              {color && (
                <button type="button" className="text-[12px] text-ink-3 underline" onClick={() => setColor('')}>
                  Text colour
                </button>
              )}
            </label>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function LucideTab({ chosen, onPick, colour }: { chosen: string | null; onPick: (name: string) => void; colour: string }) {
  const [set, setSet] = useState<LucideSet | null>(null);
  const [tags, setTags] = useState<Record<string, string[]>>({});
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let live = true;
    loadLucide()
      .then((loaded) => live && setSet(loaded))
      .catch(() => live && setFailed(true));
    loadLucideTags()
      .then((loaded) => live && setTags(loaded))
      .catch(() => {
        // Searching by name still works.
      });
    return () => {
      live = false;
    };
  }, []);
  const found = useMemo(() => {
    if (!set) return [];
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const names = Object.keys(set);
    if (words.length === 0) return names.slice(0, SHOWN);
    const score = (name: string) => {
      let total = 0;
      for (const word of words) {
        if (name === word) total += 4;
        else if (name.startsWith(word)) total += 3;
        else if (name.includes(word)) total += 2;
        else if ((tags[name] ?? []).some((tag) => tag.includes(word))) total += 1;
        else return 0;
      }
      return total;
    };
    return names
      .map((name) => [name, score(name)] as const)
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, SHOWN)
      .map(([name]) => name);
  }, [set, tags, query]);
  if (failed) return <p className="text-[12.5px] text-danger">The icons could not be loaded. Check the connection and open this again.</p>;
  return (
    <div className="flex flex-col gap-2">
      <TextInput autoFocus placeholder="Search icons: server, database, user…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search icons" />
      <div className="grid max-h-[300px] grid-cols-8 gap-1 overflow-y-auto" data-testid="icon-results">
        {!set && <span className="col-span-8 text-[12.5px] text-ink-3">Loading icons…</span>}
        {set && found.length === 0 && <span className="col-span-8 text-[12.5px] text-ink-3">No icon matches “{query}”.</span>}
        {found.map((name) => (
          <button
            key={name}
            type="button"
            title={name}
            aria-label={name}
            aria-pressed={chosen === `lucide:${name}`}
            data-icon-name={name}
            className={`flex h-12 items-center justify-center rounded-[--radius-sm] border ${chosen === `lucide:${name}` ? 'border-accent bg-accent-wash' : 'border-transparent hover:bg-sunken'}`}
            onClick={() => onPick(`lucide:${name}`)}
          >
            <LucideGlyph shapes={set![name]!} size={22} colour={colour} />
          </button>
        ))}
      </div>
      <p className="text-[11.5px] text-ink-3">
        {set ? `${Object.keys(set).length} icons from Lucide.` : ''} {found.length === SHOWN ? `Showing the first ${SHOWN}; search to narrow.` : ''}
      </p>
    </div>
  );
}

function SvgTab({
  assets,
  chosen,
  fresh,
  onPick,
  onFresh,
}: {
  assets: Record<string, CanvasAsset> | undefined;
  chosen: string | null;
  fresh: { svg: string; name?: string } | null;
  onPick: (name: string) => void;
  onFresh: (asset: { svg: string; name?: string } | null) => void;
}) {
  const [source, setSource] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const existing = Object.entries(assets ?? {});
  const full = existing.length >= STYLE_LIMITS.maxAssets;

  const read = (text: string, name?: string) => {
    setSource(text);
    if (text.trim() === '') {
      setProblem(null);
      onFresh(null);
      return;
    }
    try {
      onFresh({ svg: sanitizeSvg(text), ...(name ? { name: name.slice(0, STYLE_LIMITS.maxAssetName) } : {}) });
      setProblem(null);
    } catch (error) {
      onFresh(null);
      setProblem(error instanceof SvgError ? error.message : 'This is not an SVG Kite can use.');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {existing.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-2">On this canvas</span>
          <div className="flex flex-wrap gap-1" data-testid="icon-assets">
            {existing.map(([id, asset]) => (
              <button
                key={id}
                type="button"
                title={asset.name ?? id}
                aria-label={asset.name ?? id}
                aria-pressed={chosen === `asset:${id}`}
                className={`flex h-12 w-12 items-center justify-center rounded-[--radius-sm] border ${chosen === `asset:${id}` ? 'border-accent bg-accent-wash' : 'border-line hover:bg-sunken'}`}
                onClick={() => onPick(`asset:${id}`)}
              >
                <img src={svgDataUri(asset.svg)} width={28} height={28} alt="" />
              </button>
            ))}
          </div>
        </div>
      )}
      {full ? (
        <p className="text-[12.5px] text-ink-3">This canvas has {STYLE_LIMITS.maxAssets} custom icons, which is as many as it can hold. Reuse one of them.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-2">Add one</span>
          <div className="flex items-start gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="inline-flex w-fit cursor-pointer items-center rounded-[--radius-sm] border border-line px-2.5 py-1 text-[12.5px] hover:bg-sunken">
                Upload an .svg file
                <input
                  type="file"
                  accept=".svg,image/svg+xml"
                  className="sr-only"
                  data-testid="icon-svg-file"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > SVG_LIMITS.maxBytes) {
                      onFresh(null);
                      setProblem(`That file is ${Math.ceil(file.size / 1024)} KB. An SVG icon can be up to ${SVG_LIMITS.maxBytes / 1024} KB.`);
                      return;
                    }
                    read(await file.text(), file.name.replace(/\.svg$/i, ''));
                  }}
                />
              </label>
              <textarea
                className="h-24 w-full resize-none rounded-[--radius-sm] border border-line bg-surface p-2 font-mono text-[11.5px] text-ink outline-none focus:border-accent"
                placeholder="…or paste SVG markup: <svg …>…</svg>"
                value={source}
                aria-label="SVG markup"
                data-testid="icon-svg-paste"
                onChange={(event) => read(event.target.value)}
              />
            </div>
            <div
              className={`flex h-[104px] w-[104px] shrink-0 items-center justify-center rounded-[--radius-sm] border ${chosen === 'new' ? 'border-accent' : 'border-line'} bg-sunken`}
              data-testid="icon-svg-preview"
            >
              {fresh ? <img src={svgDataUri(fresh.svg)} width={64} height={64} alt="Preview" /> : <span className="text-[11px] text-ink-3">Preview</span>}
            </div>
          </div>
          {problem && (
            <p className="text-[12px] text-danger" role="alert" data-testid="icon-svg-problem">
              {problem}
            </p>
          )}
          <p className="text-[11.5px] text-ink-3">
            Kite keeps shapes, colours and gradients, and removes scripts, event handlers, embedded HTML and anything that links elsewhere. Up to {SVG_LIMITS.maxBytes / 1024} KB.
          </p>
        </div>
      )}
    </div>
  );
}
