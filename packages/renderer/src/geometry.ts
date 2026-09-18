import type { Point } from "@design-studio/contracts";

export type Matrix = readonly [number, number, number, number, number, number];
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function compose(parent: Matrix, local: Matrix, origin: Point): Matrix {
  return multiply(
    multiply(multiply(parent, [1, 0, 0, 1, origin.x, origin.y]), local),
    [1, 0, 0, 1, -origin.x, -origin.y],
  );
}
export function mapRect(rect: Rect, matrix: Matrix): Rect {
  const points = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ];
  const xs = points.map(
    ([x = 0, y = 0]) => matrix[0] * x + matrix[2] * y + matrix[4],
  );
  const ys = points.map(
    ([x = 0, y = 0]) => matrix[1] * x + matrix[3] * y + matrix[5],
  );
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}
