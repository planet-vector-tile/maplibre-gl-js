import WorkerTile from "./worker_tile";
import { extend } from "../util/util";

import type {
  WorkerSource,
  WorkerTileParameters,
  WorkerTileCallback,
  TileParameters,
  WorkerTileResult,
} from "../source/worker_source";

import type Actor from "../util/actor";
import type StyleLayerIndex from "../style/style_layer_index";

import type {
  VectorTile,
  VectorTileLayer,
  VectorTileFeature,
} from "@mapbox/vector-tile";

import vtpbf from 'vt-pbf';
import EXTENT from "../data/extent";
import Point from "@mapbox/point-geometry";
import { Feature } from "geojson";

// Similar to Feature in geojson_wrapper.ts
export type VTFeature =
  | {
      type: 1;
      id: number; // must be int
      tags: { [_: string]: string | number | boolean };
      geometry: Array<[number, number]>;
    }
  | {
      type: 2 | 3;
      id: number; // must be int
      tags: { [_: string]: string | number | boolean };
      geometry: Array<Array<[number, number]>>;
    };

export class PVTFeatureWrapper implements VectorTileFeature {
  _feature: VTFeature;
  extent: number;
  type: 1 | 2 | 3;
  id: number;
  properties: { [_: string]: string | number | boolean };

  constructor(feature: VTFeature) {
    this._feature = feature;

    this.extent = EXTENT;
    this.type = feature.type;
    this.properties = feature.tags;

    if (feature.id) {
      this.id = feature.id;
    }
  }

  loadGeometry(): Point[][] {
    return [[new Point(4096, 4096)]]; // center
  }

  toGeoJSON(x, y, z): Feature {
    return {
      type: "Feature",
      properties: {
        name: `id ${this.id}`
      },
      geometry: {
        type: "Point",
        coordinates: [36, 62],
      },
    };
  }

  // bbox?(): [number, number, number, number];
  // https://github.com/mapbox/vector-tile-js/blob/master/lib/vectortilefeature.js
}

class PVTLayerWrapper implements VectorTileLayer {
    name: string;
    extent: number;
    length: number;

    _features: Array<VTFeature>;

    constructor(features: Array<VTFeature>) {
        this.extent = EXTENT;
        this.length = features.length;
        this._features = features;
    }

    feature(featureIndex: number): VectorTileFeature {
        return new PVTFeatureWrapper(this._features[featureIndex])
    }
}

class PVTWrapper implements VectorTile {
    layers: {[_: string]: VectorTileLayer};

    constructor(features: Array<VTFeature>) {
        const layer = new PVTLayerWrapper(features);
        this.layers['pvt'] = layer
    }
}

let id = 0

function postProcessBuffer(params: WorkerTileParameters): { wrapper: PVTWrapper, pbfBuffer: ArrayBuffer } {
    const f = {
        type: 1,
        id: ++id,
        tags: {
            name: `id ${id}`
        },
        geometry: [[4096, 4096]] // center
    } as VTFeature
    const wrapper = new PVTWrapper([f]);

    // Create actual MapboxVectorTile protocol buffer for internal use.
    // Can we avoid this?
    const pbf: Uint8Array = vtpbf(wrapper);
    const pbfBuffer = pbf.buffer;

    return { wrapper, pbfBuffer };
}

export default class VectorTileWorkerSource implements WorkerSource {
  actor: Actor;
  layerIndex: StyleLayerIndex;
  availableImages: Array<string>;
  loaded: { [_: string]: WorkerTile };

  constructor(
    actor: Actor,
    layerIndex: StyleLayerIndex,
    availableImages: Array<string>
  ) {
    this.actor = actor;
    this.layerIndex = layerIndex;
    this.availableImages = availableImages;
    this.loaded = {};
  }

  loadTile(params: WorkerTileParameters, callback: WorkerTileCallback) {
    const workerTile = new WorkerTile(params);

    // No request to cancel.
    workerTile.abort = () => {};

    const { wrapper, pbfBuffer } = postProcessBuffer(params);
    workerTile.vectorTile = wrapper
    workerTile.parse(wrapper, this.layerIndex, this.availableImages, this.actor, (err, result) => {
        if (err) return callback(err);

        // Transferring a copy of rawTileData because the worker needs to retain its copy.
        const workerTileResult: WorkerTileResult = extend({ rawTileData: pbfBuffer.slice(0) }, result);
        callback(null, workerTileResult);
    });

    this.loaded = this.loaded || {};
    this.loaded[params.uid] = workerTile;
  }

  reloadTile(params: WorkerTileParameters, callback: WorkerTileCallback) {
    const loaded = this.loaded;
    const uid = params.uid;
    const self = this;
    if (loaded && loaded[uid]) {
      const workerTile = loaded[uid];
      workerTile.showCollisionBoxes = params.showCollisionBoxes;

      const done = (err?: Error, data?: any) => {
        const reloadCallback = workerTile.reloadCallback;
        if (reloadCallback) {
          delete workerTile.reloadCallback;
          workerTile.parse(
            workerTile.vectorTile,
            self.layerIndex,
            this.availableImages,
            self.actor,
            reloadCallback
          );
        }
        callback(err, data);
      };

      if (workerTile.status === "parsing") {
        workerTile.reloadCallback = done;
      } else if (workerTile.status === "done") {
        // if there was no vector tile data on the initial load, don't try and re-parse tile
        if (workerTile.vectorTile) {
          workerTile.parse(
            workerTile.vectorTile,
            this.layerIndex,
            this.availableImages,
            this.actor,
            done
          );
        } else {
          done();
        }
      }
    }
  }

  abortTile(params: TileParameters, callback: WorkerTileCallback) {
    // There is no request to abort
    callback();
  }

  removeTile(params: TileParameters, callback: WorkerTileCallback) {
    const loaded = this.loaded;
    const uid = params.uid;
    if (loaded && loaded[uid]) {
      delete loaded[uid];
    }
    callback();
  }
}

