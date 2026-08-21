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
  CylinderGeometry_default
} from "./chunk-HS6AD4P2.js";
import "./chunk-A3O6EDBK.js";
import "./chunk-UEY73NRN.js";
import "./chunk-6HK6IXK2.js";
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
import "./chunk-A6X24AZI.js";
import "./chunk-ZSGUV73H.js";
import "./chunk-C7JQVRLM.js";
import "./chunk-6YR6JBMY.js";
import {
  defined_default
} from "./chunk-AHWAZRBV.js";

// packages/engine/Source/Workers/createCylinderGeometry.js
function createCylinderGeometry(cylinderGeometry, offset) {
  if (defined_default(offset)) {
    cylinderGeometry = CylinderGeometry_default.unpack(cylinderGeometry, offset);
  }
  return CylinderGeometry_default.createGeometry(cylinderGeometry);
}
var createCylinderGeometry_default = createCylinderGeometry;
export {
  createCylinderGeometry_default as default
};
