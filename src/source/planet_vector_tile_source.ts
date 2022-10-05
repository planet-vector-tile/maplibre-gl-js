import { VectorSourceSpecification } from "../style-spec/types.g";
import { Callback } from "../types/callback";
import type Map from "../ui/map";
import Dispatcher from "../util/dispatcher";
import {cacheEntryPossiblyAdded} from '../util/tile_request_cache'
import { Event, Evented } from "../util/evented";
import { extend, pick } from "../util/util";
import { Source } from "./source";
import Tile from "./tile";

let planetPlugin = null;

export function setPlanetVectorTilePlugin(plugin) {
  planetPlugin = plugin;
}

export default class PlanetVectorTileSource extends Evented implements Source {
  type: "planet";
  id: string;
  minzoom: number;
  maxzoom: number;
  tileSize: number;

  // According to interface Source, `false` if tiles can be drawn outside their
  // boundaries, `true` if they cannot.
  isTileClipped: boolean;
  reparseOverscaled: boolean;

  _options: VectorSourceSpecification;
  dispatcher: Dispatcher;
  map: Map;
  bounds: [number, number, number, number];

  // url: string is omitted, because that is just for TileJSON

  // This is the arr
  tiles: Array<string>;
  _loaded: boolean;

  // Note: Not using promoteId, since we have full control of our source data.

  constructor(
    id: string,
    options: VectorSourceSpecification,
    dispatcher: Dispatcher,
    eventedParent: Evented
  ) {
    super();
    this.id = id;
    this.dispatcher = dispatcher;
    this.type = "planet";
    this.minzoom = 0;
    this.maxzoom = 22;
    this.tileSize = 512;

    // Experiment with supporting larger tile sizes?
    if (this.tileSize !== 512) {
      throw new Error("vector tile sources must have a tileSize of 512");
    }

    // Maybe make it so this is not necessary?
    this.reparseOverscaled = true;

    // Experiment with turning this off?
    this.isTileClipped = true;

    extend(this, pick(options, ["tileSize"]));
    this._options = extend({ type: "planet" }, options);

    this._loaded = false;

    this.setEventedParent(eventedParent);
  }

  // VectorTileSource has additional logic for loading TileJSON. We probably don't need that.
  load() {
    if (!planetPlugin) {
        throw new Error('The PlanetVectorTile plugin has not been loaded! Cannot load planet source.')
    }

    this.fire(
      new Event("data", { dataType: "source", sourceDataType: "metadata" })
    );
    this.fire(
      new Event("data", { dataType: "source", sourceDataType: "content" })
    );
    this._loaded = true;
  }

  loaded(): boolean {
    return this._loaded;
  }

  // Omitting hasTile like GeoJSONSource.
  // Would need tile bounds, which is defined in TileJSON.

  onAdd(map: Map) {
    this.map = map;
    this.load();
  }

  setSourceProperty(callback: Function) {
    // VectorTileSource would also cancel _tileJSONRequest
    callback();
    this.load();
  }

  setTiles(tiles: Array<string>) {
    this.setSourceProperty(() => {
      this._options.tiles = tiles;
    });

    return this;
  }

  // Omit setUrl

  // Omit onRemove

  serialize() {
    return extend({}, this._options);
  }

  // TODO
  loadTile(tile: Tile, callback: Callback<void>) {
    if (!planetPlugin) {
        throw new Error('The PlanetVectorTile plugin has not been loaded! Cannot load tile.')
    }

    const url = tile.tileID.canonical.url(this.tiles, this.map.getPixelRatio(), this.scheme);
    const params = {
        request: this.map._requestManager.transformRequest(url, ResourceType.Tile),
        uid: tile.uid,
        tileID: tile.tileID,
        zoom: tile.tileID.overscaledZ,
        tileSize: this.tileSize * tile.tileID.overscaleFactor(),
        type: this.type,
        source: this.id,
        pixelRatio: this.map.getPixelRatio(),
        showCollisionBoxes: this.map.showCollisionBoxes,
        promoteId: this.promoteId
    };
    params.request.collectResourceTiming = this._collectResourceTiming;

    if (!tile.actor || tile.state === 'expired') {
        tile.actor = this.dispatcher.getActor();
        tile.request = tile.actor.send('loadTile', params, done.bind(this));
    } else if (tile.state === 'loading') {
        // schedule tile reloading after it has been loaded
        tile.reloadCallback = callback;
    } else {
        tile.request = tile.actor.send('reloadTile', params, done.bind(this));
    }

    function done(err, data) {
        delete tile.request;

        if (tile.aborted)
            return callback(null);

        if (err && err.status !== 404) {
            return callback(err);
        }

        if (data && data.resourceTiming)
            tile.resourceTiming = data.resourceTiming;

        if (this.map._refreshExpiredTiles && data) tile.setExpiryData(data);
        tile.loadVectorData(data, this.map.painter);

        cacheEntryPossiblyAdded(this.dispatcher);

        callback(null);

        if (tile.reloadCallback) {
            this.loadTile(tile, tile.reloadCallback);
            tile.reloadCallback = null;
        }
    }
}

  hasTransition() {
    return false;
  }
}
