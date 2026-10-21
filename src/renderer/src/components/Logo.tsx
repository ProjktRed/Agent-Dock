import { LOGO } from "../../../../scripts/logo-shapes.mjs";

const fill = ([r, g, b]: [number, number, number]) => `rgb(${r} ${g} ${b})`;

/** Agent Dock mark, drawn from the same geometry as the app and exe icons. */
export function Logo({ size = 22, background = false }: { size?: number; background?: boolean }) {
  const shapes = background ? [LOGO.background, ...LOGO.layers] : LOGO.layers;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flex: "none" }}>
      {shapes.map((s, i) => (
        <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r} fill={!background && s.color === LOGO.background.color ? "var(--logo-cut, var(--b))" : fill(s.color)} />
      ))}
    </svg>
  );
}
