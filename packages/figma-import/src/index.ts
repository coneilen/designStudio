export { type ConversionLimits, FigmaImportError } from "./boundary.js";
export {
  convertFigmaSnapshot,
  convertFigmaStructure,
  type FigmaConversion,
  type FigmaConversionInput,
  type FigmaStructureConversion,
  type FigmaStructureInput,
} from "./converter.js";
export { type FigmaSelection, parseFigmaSelection } from "./selection.js";
export { verifyFigmaConversion } from "./verify.js";
