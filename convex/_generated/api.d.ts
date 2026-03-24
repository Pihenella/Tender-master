/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as analysis from "../analysis.js";
import type * as analysisActions from "../analysisActions.js";
import type * as analysisHelpers from "../analysisHelpers.js";
import type * as authHelper from "../authHelper.js";
import type * as calculationUpload from "../calculationUpload.js";
import type * as crons from "../crons.js";
import type * as docxSlicer from "../docxSlicer.js";
import type * as files from "../files.js";
import type * as formFilling from "../formFilling.js";
import type * as formFillingActions from "../formFillingActions.js";
import type * as googleDrive from "../googleDrive.js";
import type * as http from "../http.js";
import type * as logistics from "../logistics.js";
import type * as opusApi from "../opusApi.js";
import type * as procurements from "../procurements.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  analysis: typeof analysis;
  analysisActions: typeof analysisActions;
  analysisHelpers: typeof analysisHelpers;
  authHelper: typeof authHelper;
  calculationUpload: typeof calculationUpload;
  crons: typeof crons;
  docxSlicer: typeof docxSlicer;
  files: typeof files;
  formFilling: typeof formFilling;
  formFillingActions: typeof formFillingActions;
  googleDrive: typeof googleDrive;
  http: typeof http;
  logistics: typeof logistics;
  opusApi: typeof opusApi;
  procurements: typeof procurements;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
