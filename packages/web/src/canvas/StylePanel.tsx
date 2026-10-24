/**
 * The style panel: how the selected nodes and edges look, or, with nothing
 * selected, the canvas theme every node and edge starts from. A column beside
 * the canvas rather than over it, so it never hides what it is styling.
 *
 * A control shows the value the selection has of its own; empty means the
 * default (the theme's, or Kite's). When the selection disagrees it says
 * Mixed, and setting it sets every selected item. Each change is one batch.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CANVAS_FONT_LABELS,
  CANVAS_FONTS,
  CANVAS_WEIGHTS,
  isCanvasPaint,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasEdgeStyle,
  type CanvasNode,
  type CanvasNodeStyle,
  type CanvasOp,
  type CanvasTheme,
} from '@open-artifact/shared';
import { Button } from '../components/primitives.js';
import { paint, PRESET_COLOURS } from './look.js';
import { NodeIcon, type LucideSet } from './icons.js';
import { common, edgeStyleOps, iconOps, nodeStyleOps, resetEdgeOps, resetNodeOps, themeOps, type Change, type EdgeChange } from './style-ops.js';

export interface StylePanelProps {
  doc: CanvasDocument;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  lucide: LucideSet | null;
  apply: (ops: CanvasOp[]) => void;
  onPickIcon: () => void;
  onClose: () => void;
}

export function StylePanel({ doc, nodes, edges, lucide, apply, onPickIcon, onClose }: StylePanelProps) {
  const title =
    nodes.length + edges.length === 0
      ? 'Canvas'
      : [nodes.length ? plural(nodes.length, 'node') : '', edges.length ? plural(edges.length, 'edge') : ''].filter(Boolean).join(', ');
  return (
    <aside
      className="flex h-full w-[264px] shrink-0 flex-col overflow-hidden border-l border-line bg-surface text-[12.5px]"
      data-testid="canvas-style-panel"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="font-medium text-ink">Style · {title}</span>
        <button type="button" className="rounded px-1 text-ink-3 hover:bg-sunken hover:text-ink" onClick={onClose} aria-label="Close style panel">
          ×
        </button>
      </div>
      <div className="flex flex-col gap-3 overflow-y-auto px-3 py-2.5">
        {nodes.length > 0 && <NodeSection doc={doc} nodes={nodes} lucide={lucide} apply={apply} onPickIcon={onPickIcon} />}
        {edges.length > 0 && <EdgeSection edges={edges} apply={apply} />}
        {nodes.length + edges.length === 0 && <ThemeSection theme={doc.kite?.theme} apply={apply} />}
      </div>
    </aside>
  );
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function NodeSection({
  doc,
  nodes,
  lucide,
  apply,
  onPickIcon,
}: {
  doc: CanvasDocument;
  nodes: CanvasNode[];
  lucide: LucideSet | null;
  apply: (ops: CanvasOp[]) => void;
  onPickIcon: () => void;
}) {
  const own = <K extends keyof CanvasNodeStyle>(key: K) => common(nodes.map((n) => n.kite?.style?.[key]));
  const set = (change: Change<CanvasNodeStyle>) => apply(nodeStyleOps(nodes, change));
  const groups = nodes.filter((n) => n.type === 'group');
  const icons = common(nodes.map((n) => n.kite?.icon?.name));
  const icon = nodes.find((n) => n.kite?.icon)?.kite?.icon;
  const styled = nodes.some((n) => n.kite?.style || n.color);
  return (
    <>
      <Section title="Box">
        <Row label="Fill">
          <ColorField testId="style-fill" {...own('fill')} onChange={(fill) => set({ fill })} />
        </Row>
        <Row label="Border">
          <ColorField testId="style-borderColor" {...own('borderColor')} onChange={(borderColor) => set({ borderColor })} />
        </Row>
        <Row label="">
          <NumberField testId="style-borderWidth" label="Border width" suffix="px" min={0} max={16} {...own('borderWidth')} onChange={(borderWidth) => set({ borderWidth })} />
          <SelectField
            testId="style-borderStyle"
            label="Border style"
            options={[['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']]}
            {...own('borderStyle')}
            onChange={(borderStyle) => set({ borderStyle })}
          />
        </Row>
        <Row label="Corners">
          <NumberField testId="style-radius" label="Corner radius" suffix="px" min={0} max={96} {...own('radius')} onChange={(radius) => set({ radius })} />
          <SelectField
            testId="style-shadow"
            label="Shadow"
            options={[['none', 'No shadow'], ['sm', 'Shadow S'], ['md', 'Shadow M'], ['lg', 'Shadow L']]}
            {...own('shadow')}
            onChange={(shadow) => set({ shadow })}
          />
        </Row>
      </Section>
      <Section title="Text">
        <Row label="Colour">
          <ColorField testId="style-textColor" {...own('textColor')} onChange={(textColor) => set({ textColor })} />
        </Row>
        <Row label="Font">
          <FontField testId="style-font" {...own('font')} onChange={(font) => set({ font })} />
        </Row>
        <Row label="">
          <NumberField testId="style-fontSize" label="Font size" suffix="px" min={8} max={96} {...own('fontSize')} onChange={(fontSize) => set({ fontSize })} />
          <WeightField testId="style-fontWeight" {...own('fontWeight')} onChange={(fontWeight) => set({ fontWeight })} />
        </Row>
        <Row label="Align">
          <Segmented
            testId="style-textAlign"
            options={[['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]}
            {...own('textAlign')}
            onChange={(textAlign) => set({ textAlign })}
          />
        </Row>
        <Row label="">
          <Segmented
            testId="style-verticalAlign"
            options={[['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']]}
            {...own('verticalAlign')}
            onChange={(verticalAlign) => set({ verticalAlign })}
          />
        </Row>
      </Section>
      {groups.length > 0 && <GroupLabelSection groups={groups} apply={apply} />}
      <Section title="Icon">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded border border-line bg-sunken">
            {icon && !icons.mixed && <NodeIcon icon={{ ...icon, size: 20 }} assets={doc.kite?.assets} lucide={lucide} ink="var(--color-ink)" />}
            {icons.mixed && <span className="text-[11px] text-ink-3">…</span>}
          </span>
          <Button size="sm" onClick={onPickIcon} data-testid="style-icon-choose">
            {icon ? 'Change…' : 'Choose…'}
          </Button>
          {icon && (
            <Button size="sm" tone="ghost" onClick={() => apply(iconOps(nodes.filter((n) => n.kite?.icon), null))} data-testid="style-icon-remove">
              Remove
            </Button>
          )}
        </div>
      </Section>
      {styled && (
        <Button size="sm" tone="ghost" className="self-start" onClick={() => apply(resetNodeOps(nodes))} data-testid="style-reset">
          Reset to theme
        </Button>
      )}
    </>
  );
}

function GroupLabelSection({ groups, apply }: { groups: CanvasNode[]; apply: (ops: CanvasOp[]) => void }) {
  const own = <K extends keyof CanvasNodeStyle>(key: K) => common(groups.map((n) => n.kite?.style?.[key]));
  const set = (change: Change<CanvasNodeStyle>) => apply(nodeStyleOps(groups, change));
  return (
    <Section title="Group name">
      <Row label="Colour">
        <ColorField testId="style-labelColor" {...own('labelColor')} onChange={(labelColor) => set({ labelColor })} />
      </Row>
      <Row label="Behind">
        <ColorField testId="style-labelBackground" {...own('labelBackground')} onChange={(labelBackground) => set({ labelBackground })} />
      </Row>
      <Row label="Font">
        <FontField testId="style-labelFont" {...own('labelFont')} onChange={(labelFont) => set({ labelFont })} />
      </Row>
      <Row label="">
        <NumberField testId="style-labelSize" label="Name size" suffix="px" min={8} max={96} {...own('labelSize')} onChange={(labelSize) => set({ labelSize })} />
        <WeightField testId="style-labelWeight" {...own('labelWeight')} onChange={(labelWeight) => set({ labelWeight })} />
      </Row>
    </Section>
  );
}

function EdgeSection({ edges, apply }: { edges: CanvasEdge[]; apply: (ops: CanvasOp[]) => void }) {
  const own = <K extends keyof CanvasEdgeStyle>(key: K) => common(edges.map((e) => e.kite?.style?.[key]));
  const set = (change: EdgeChange) => apply(edgeStyleOps(edges, change));
  const color = common(edges.map((e) => e.color));
  const start = common(edges.map((e) => e.fromEnd === 'arrow'));
  const end = common(edges.map((e) => e.toEnd !== 'none'));
  return (
    <>
      <Section title="Line">
        <Row label="Colour">
          <ColorField testId="style-edge-color" {...color} onChange={(value) => set({ color: value })} />
        </Row>
        <Row label="">
          <NumberField testId="style-edge-width" label="Line width" suffix="px" min={1} max={12} {...own('width')} onChange={(width) => set({ width })} />
          <SelectField
            testId="style-edge-line"
            label="Line"
            options={[['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']]}
            {...own('line')}
            onChange={(line) => set({ line })}
          />
        </Row>
        <Row label="Curve">
          <Segmented
            testId="style-edge-curve"
            options={[['bezier', 'Curved'], ['straight', 'Straight'], ['step', 'Step']]}
            {...own('curve')}
            onChange={(curve) => set({ curve })}
          />
        </Row>
        <Row label="Arrows">
          <Toggle testId="style-edge-start" label="Start" on={start.value === true} mixed={start.mixed} onChange={(on) => set({ fromEnd: on ? 'arrow' : 'none' })} />
          <Toggle testId="style-edge-end" label="End" on={end.value === true} mixed={end.mixed} onChange={(on) => set({ toEnd: on ? 'arrow' : 'none' })} />
        </Row>
      </Section>
      <Section title="Label">
        <Row label="Colour">
          <ColorField testId="style-edge-labelColor" {...own('labelColor')} onChange={(labelColor) => set({ labelColor })} />
        </Row>
        <Row label="Behind">
          <ColorField testId="style-edge-labelBackground" {...own('labelBackground')} onChange={(labelBackground) => set({ labelBackground })} />
        </Row>
        <Row label="Font">
          <FontField testId="style-edge-labelFont" {...own('labelFont')} onChange={(labelFont) => set({ labelFont })} />
        </Row>
        <Row label="">
          <NumberField testId="style-edge-labelSize" label="Label size" suffix="px" min={8} max={96} {...own('labelSize')} onChange={(labelSize) => set({ labelSize })} />
          <WeightField testId="style-edge-labelWeight" {...own('labelWeight')} onChange={(labelWeight) => set({ labelWeight })} />
        </Row>
      </Section>
      {edges.some((e) => e.kite?.style || e.color) && (
        <Button size="sm" tone="ghost" className="self-start" onClick={() => apply(resetEdgeOps(edges))} data-testid="style-edge-reset">
          Reset to theme
        </Button>
      )}
    </>
  );
}

function ThemeSection({ theme, apply }: { theme: CanvasTheme | undefined; apply: (ops: CanvasOp[]) => void }) {
  const one = <T,>(value: T | undefined) => ({ value, mixed: false });
  const node = theme?.node ?? {};
  const group = theme?.group ?? {};
  const edge = theme?.edge ?? {};
  return (
    <>
      <p className="text-[11.5px] leading-snug text-ink-3">Nothing is selected, so this is the canvas theme: what every node and edge looks like unless it says otherwise.</p>
      <Section title="Canvas">
        <Row label="Background">
          <ColorField testId="theme-background" {...one(theme?.background)} onChange={(background) => apply(themeOps({ background }))} />
        </Row>
        <Row label="Grid">
          <SelectField
            testId="theme-grid"
            label="Grid"
            options={[['dots', 'Dots'], ['lines', 'Lines'], ['cross', 'Crosses'], ['none', 'None']]}
            {...one(theme?.grid)}
            onChange={(grid) => apply(themeOps({ grid }))}
          />
        </Row>
        <Row label="Grid colour">
          <ColorField testId="theme-gridColor" {...one(theme?.gridColor)} onChange={(gridColor) => apply(themeOps({ gridColor }))} />
        </Row>
      </Section>
      <Section title="Cards">
        <Row label="Fill">
          <ColorField testId="theme-node-fill" {...one(node.fill)} onChange={(fill) => apply(themeOps({ node: { fill } }))} />
        </Row>
        <Row label="Border">
          <ColorField testId="theme-node-borderColor" {...one(node.borderColor)} onChange={(borderColor) => apply(themeOps({ node: { borderColor } }))} />
        </Row>
        <Row label="Text">
          <ColorField testId="theme-node-textColor" {...one(node.textColor)} onChange={(textColor) => apply(themeOps({ node: { textColor } }))} />
        </Row>
        <Row label="Font">
          <FontField testId="theme-node-font" {...one(node.font)} onChange={(font) => apply(themeOps({ node: { font } }))} />
        </Row>
        <Row label="Corners">
          <NumberField testId="theme-node-radius" label="Corner radius" suffix="px" min={0} max={96} {...one(node.radius)} onChange={(radius) => apply(themeOps({ node: { radius } }))} />
          <SelectField
            testId="theme-node-shadow"
            label="Shadow"
            options={[['none', 'No shadow'], ['sm', 'Shadow S'], ['md', 'Shadow M'], ['lg', 'Shadow L']]}
            {...one(node.shadow)}
            onChange={(shadow) => apply(themeOps({ node: { shadow } }))}
          />
        </Row>
      </Section>
      <Section title="Groups">
        <Row label="Border">
          <ColorField testId="theme-group-borderColor" {...one(group.borderColor)} onChange={(borderColor) => apply(themeOps({ group: { borderColor } }))} />
        </Row>
        <Row label="Name font">
          <FontField testId="theme-group-labelFont" {...one(group.labelFont)} onChange={(labelFont) => apply(themeOps({ group: { labelFont } }))} />
        </Row>
      </Section>
      <Section title="Edges">
        <Row label="Colour">
          <ColorField testId="theme-edge-color" {...one(edge.color)} onChange={(color) => apply(themeOps({ edge: { color } }))} />
        </Row>
        <Row label="">
          <NumberField testId="theme-edge-width" label="Line width" suffix="px" min={1} max={12} {...one(edge.width)} onChange={(width) => apply(themeOps({ edge: { width } }))} />
          <SelectField
            testId="theme-edge-line"
            label="Line"
            options={[['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']]}
            {...one(edge.line)}
            onChange={(line) => apply(themeOps({ edge: { line } }))}
          />
        </Row>
        <Row label="Curve">
          <Segmented
            testId="theme-edge-curve"
            options={[['bezier', 'Curved'], ['straight', 'Straight'], ['step', 'Step']]}
            {...one(edge.curve)}
            onChange={(curve) => apply(themeOps({ edge: { curve } }))}
          />
        </Row>
      </Section>
      {theme && (
        <Button size="sm" tone="ghost" className="self-start" onClick={() => apply([{ op: 'theme', set: null }])} data-testid="theme-reset">
          Reset theme
        </Button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[62px] shrink-0 text-[12px] text-ink-2">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

const SWATCHES = ['1', '2', '3', '4', '5', '6', '#ffffff', '#f4f4f5', '#71717a', '#18181b'];

const CONTROL = 'h-7 rounded-[--radius-sm] border border-line bg-surface px-1.5 text-[12px] text-ink outline-none focus:border-accent';

interface FieldProps<T> {
  value: T | undefined;
  mixed: boolean;
  onChange: (value: T | null) => void;
  testId: string;
}

/** Spec presets and a few neutrals, a hex field, and the system colour picker. */
function ColorField({ value, mixed, onChange, testId }: FieldProps<string>) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  const picker = useRef<HTMLInputElement>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  // The system picker reports every step of a drag as 'input'; only its final
  // choice, the native 'change' event, becomes a version.
  useEffect(() => {
    const input = picker.current;
    if (!input) return;
    const onPicked = () => changeRef.current(input.value);
    input.addEventListener('change', onPicked);
    return () => input.removeEventListener('change', onPicked);
  }, [open]);
  const commitDraft = () => {
    const next = draft.trim();
    if (next === (value ?? '')) return;
    if (next === '') onChange(null);
    else if (isCanvasPaint(next)) onChange(next);
    else setDraft(value ?? '');
  };
  const shown = value ? paint(value) : undefined;
  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-1.5" data-testid={testId}>
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[--radius-sm] border border-line"
        style={shown ? { background: shown === 'transparent' ? undefined : shown } : undefined}
        aria-label={mixed ? 'Mixed colours' : value ? `Colour ${value}` : 'Default colour'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {!value && <span className="text-[10px] text-ink-3">{mixed ? '…' : '–'}</span>}
        {value === 'transparent' && <span className="text-[10px] text-ink-3">∅</span>}
      </button>
      <input
        className={`${CONTROL} min-w-0 flex-1 font-mono`}
        value={draft}
        placeholder={mixed ? 'Mixed' : 'Default'}
        aria-label="Colour"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commitDraft();
        }}
      />
      {open && (
        <div className="absolute left-0 top-8 z-20 w-[208px] rounded-md border border-line bg-surface p-2 shadow-[--shadow-pop]">
          <div className="grid grid-cols-5 gap-1.5">
            {SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={`h-7 rounded-[--radius-sm] border ${value === swatch ? 'border-accent ring-2 ring-accent/40' : 'border-line'}`}
                style={{ background: paint(swatch) }}
                title={PRESET_COLOURS[swatch] ? `Preset ${swatch}` : swatch}
                aria-label={PRESET_COLOURS[swatch] ? `Preset colour ${swatch}` : `Colour ${swatch}`}
                onClick={() => {
                  onChange(swatch);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <label className="flex flex-1 items-center gap-1.5 text-[12px] text-ink-2">
              <input ref={picker} type="color" className="h-7 w-9 cursor-pointer rounded border border-line bg-surface p-0.5" defaultValue={shown?.startsWith('#') && shown.length === 7 ? shown : '#0090ff'} aria-label="Pick any colour" />
              Any colour
            </label>
            <button type="button" className="rounded px-1.5 py-1 text-[12px] text-ink-2 hover:bg-sunken" onClick={() => { onChange('transparent'); setOpen(false); }}>
              None
            </button>
            <button type="button" className="rounded px-1.5 py-1 text-[12px] text-ink-2 hover:bg-sunken" onClick={() => { onChange(null); setOpen(false); }}>
              Default
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NumberField({ value, mixed, onChange, testId, label, suffix, min, max }: FieldProps<number> & { label: string; suffix: string; min: number; max: number }) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    const text = draft.trim();
    if (text === (value === undefined ? '' : String(value))) return;
    if (text === '') return onChange(null);
    const number = Number(text);
    if (!Number.isFinite(number)) return setDraft(value === undefined ? '' : String(value));
    onChange(Math.min(max, Math.max(min, Math.round(number))));
  };
  return (
    <label className="relative flex min-w-0 flex-1 items-center" title={label}>
      <input
        className={`${CONTROL} w-full pr-6`}
        inputMode="numeric"
        value={draft}
        placeholder={mixed ? 'Mixed' : 'Auto'}
        aria-label={label}
        data-testid={testId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
      <span className="pointer-events-none absolute right-1.5 text-[11px] text-ink-3">{suffix}</span>
    </label>
  );
}

function SelectField<T extends string | number>({ value, mixed, onChange, testId, label, options }: FieldProps<T> & { label: string; options: Array<[T, string]> }) {
  return (
    <select
      className={`${CONTROL} min-w-0 flex-1`}
      value={value === undefined ? '' : String(value)}
      aria-label={label}
      data-testid={testId}
      onChange={(event) => {
        const chosen = options.find(([option]) => String(option) === event.target.value);
        onChange(chosen ? chosen[0] : null);
      }}
    >
      <option value="">{mixed ? 'Mixed' : 'Default'}</option>
      {options.map(([option, text]) => (
        <option key={String(option)} value={String(option)}>
          {text}
        </option>
      ))}
    </select>
  );
}

const FONT_OPTIONS = CANVAS_FONTS.map((font) => [font, CANVAS_FONT_LABELS[font]] as [typeof font, string]);

function FontField(props: FieldProps<(typeof CANVAS_FONTS)[number]>) {
  return <SelectField {...props} label="Font" options={FONT_OPTIONS} />;
}

const WEIGHT_NAMES: Record<number, string> = { 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold' };
const WEIGHT_OPTIONS = CANVAS_WEIGHTS.map((weight) => [weight, WEIGHT_NAMES[weight]!] as [typeof weight, string]);

function WeightField(props: FieldProps<(typeof CANVAS_WEIGHTS)[number]>) {
  return <SelectField {...props} label="Weight" options={WEIGHT_OPTIONS} />;
}

function Segmented<T extends string>({ value, onChange, testId, options }: FieldProps<T> & { options: Array<[T, string]> }) {
  return (
    <div className="flex flex-1 rounded-[--radius-sm] border border-line p-0.5" role="group" data-testid={testId}>
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          className={`h-6 flex-1 rounded-[4px] text-[11.5px] ${value === option ? 'bg-accent-wash font-medium text-accent' : 'text-ink-2 hover:bg-sunken'}`}
          // Pressing the chosen one again goes back to the default.
          onClick={() => onChange(value === option ? null : option)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, on, mixed, onChange, testId }: { label: string; on: boolean; mixed: boolean; onChange: (on: boolean) => void; testId: string }) {
  return (
    <button
      type="button"
      aria-pressed={mixed ? 'mixed' : on}
      data-testid={testId}
      className={`h-7 flex-1 rounded-[--radius-sm] border text-[12px] ${on && !mixed ? 'border-accent bg-accent-wash text-accent' : 'border-line text-ink-2 hover:bg-sunken'}`}
      onClick={() => onChange(mixed ? true : !on)}
    >
      {label}
    </button>
  );
}
