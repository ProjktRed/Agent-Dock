type RGB = [number, number, number];
interface Shape {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  color: RGB;
}
export declare const LOGO: { background: Shape; layers: Shape[] };
export declare function logoSvg(options?: { background?: boolean }): string;
