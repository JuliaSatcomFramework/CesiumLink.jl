/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.143.0
 *
 * Copyright 2011-2022 Cesium Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Columbus View (Pat. Pend.)
 *
 * Portions licensed separately.
 * See https://github.com/CesiumGS/cesium/blob/main/LICENSE.md for full licensing details.
 */

import {
  EllipseGeometry_default
} from "./chunk-OBEU25PI.js";
import "./chunk-B4CQSLZJ.js";
import "./chunk-FCP2QY4G.js";
import "./chunk-EHTS2YPT.js";
import "./chunk-RG4F5R57.js";
import "./chunk-SS5ABQGY.js";
import "./chunk-UEY73NRN.js";
import "./chunk-6HK6IXK2.js";
import "./chunk-ZMBHFYOX.js";
import "./chunk-DIGUUD6G.js";
import "./chunk-XQ3SKCMM.js";
import "./chunk-CDJDJ5LK.js";
import "./chunk-ILME5BXA.js";
import "./chunk-YKU2Q3A2.js";
import "./chunk-JKXV6PG5.js";
import "./chunk-GSWMAFTE.js";
import "./chunk-IGAZBTFZ.js";
import "./chunk-VAL7DYNR.js";
import "./chunk-N7CCOFLX.js";
import "./chunk-GXWQZBAI.js";
import {
  Ellipsoid_default
} from "./chunk-A6X24AZI.js";
import {
  Cartesian3_default
} from "./chunk-ZSGUV73H.js";
import "./chunk-C7JQVRLM.js";
import "./chunk-6YR6JBMY.js";
import {
  defined_default
} from "./chunk-AHWAZRBV.js";

// packages/engine/Source/Workers/createEllipseGeometry.js
function createEllipseGeometry(ellipseGeometry, offset) {
  if (defined_default(offset)) {
    ellipseGeometry = EllipseGeometry_default.unpack(ellipseGeometry, offset);
  }
  ellipseGeometry._center = Cartesian3_default.clone(ellipseGeometry._center);
  ellipseGeometry._ellipsoid = Ellipsoid_default.clone(ellipseGeometry._ellipsoid);
  return EllipseGeometry_default.createGeometry(ellipseGeometry);
}
var createEllipseGeometry_default = createEllipseGeometry;
export {
  createEllipseGeometry_default as default
};
