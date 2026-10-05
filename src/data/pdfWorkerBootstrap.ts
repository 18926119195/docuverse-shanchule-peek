/**
 * ESM worker entry: apply ArrayBuffer polyfills in the worker realm,
 * then load pdf.js legacy worker (main-thread polyfills do not apply here).
 */
import { ensurePdfRuntimePolyfills } from './pdfPolyfills'

ensurePdfRuntimePolyfills()

import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'
