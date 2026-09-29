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
  Cesium3DTilesTerrainGeometryProcessor_default
} from "./chunk-E7NZJOK7.js";
import "./chunk-UVO6COT2.js";
import "./chunk-ENNFMWDW.js";
import {
  createTaskProcessorWorker_default
} from "./chunk-XDWCTQCZ.js";
import "./chunk-7KVKHY7O.js";
import "./chunk-WBSY7HDY.js";
import "./chunk-RG4F5R57.js";
import "./chunk-JW6OZT4R.js";
import "./chunk-HHV3MCGV.js";
import "./chunk-ZMBHFYOX.js";
import "./chunk-DIGUUD6G.js";
import "./chunk-XQ3SKCMM.js";
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
import "./chunk-AHWAZRBV.js";

// packages/engine/Source/Workers/createVerticesFromCesium3DTilesTerrain.js
function createVerticesFromCesium3DTilesTerrain(options, transferableObjects) {
  const meshPromise = Cesium3DTilesTerrainGeometryProcessor_default.createMesh(options);
  return meshPromise.then(function(mesh) {
    const verticesBuffer = mesh.vertices.buffer;
    const indicesBuffer = mesh.indices.buffer;
    const westIndicesBuffer = mesh.westIndicesSouthToNorth.buffer;
    const southIndicesBuffer = mesh.southIndicesEastToWest.buffer;
    const eastIndicesBuffer = mesh.eastIndicesNorthToSouth.buffer;
    const northIndicesBuffer = mesh.northIndicesWestToEast.buffer;
    transferableObjects.push(
      verticesBuffer,
      indicesBuffer,
      westIndicesBuffer,
      southIndicesBuffer,
      eastIndicesBuffer,
      northIndicesBuffer
    );
    return {
      verticesBuffer,
      indicesBuffer,
      vertexCountWithoutSkirts: mesh.vertexCountWithoutSkirts,
      indexCountWithoutSkirts: mesh.indexCountWithoutSkirts,
      encoding: mesh.encoding,
      westIndicesBuffer,
      southIndicesBuffer,
      eastIndicesBuffer,
      northIndicesBuffer
    };
  });
}
var createVerticesFromCesium3DTilesTerrain_default = createTaskProcessorWorker_default(
  createVerticesFromCesium3DTilesTerrain
);
export {
  createVerticesFromCesium3DTilesTerrain_default as default
};
