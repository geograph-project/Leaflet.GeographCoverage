/**
 * GeoGraph geographic photo archive project
 * This file copyright (C) 2018  Barry Hunter (geo@barryhunter.co.uk)
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.
 */

/* 
* Plots Geograph coverage circles, aligned to grid. 
* src: https://github.com/barryhunter/Leaflet.GeographCoverage
* 
* Prerequisites:
*   https://github.com/ded/reqwest OR jquery 1.8 ish (can use either to make ajax requests as both very similar!
*
* Minimal example, including a dynamic grid 
*   see: https://www.geograph.org/leaflet/GeographCoverage.html
*   
* Clearly inspired and draws ideas from:
*   https://github.com/MatthewBarker/leaflet-wikipedia/
*   https://github.com/turban/Leaflet.Photo/
**/


L.GeographCoverage = L.FeatureGroup.extend({
	options: {
		bounds: L.latLngBounds(L.latLng(49.863788, -13.688451), L.latLng(60.860395, 1.795260)), 
		minZoom: 13, maxZoom: 18,
		squareScale: 'square',
		query: '',
		user_id: null,
        opacity: 1,
        scoutLayer: null //can link in the scout layer (even if not on the map!)
	},

	initialize: function (options) {
		L.setOptions(this, options);
		L.FeatureGroup.prototype.initialize.call(this);

		this._labels = [];
		this._circles = [];
	},

	//stolen from https://github.com/MatthewBarker/leaflet-wikipedia/blob/master/source/leaflet-wikipedia.js
    /**
        Store a reference to the map and call the requestData() method.
        @private
    */
    onAdd: function (map) {
        map.on('moveend', this.requestData, this);

        //we dont can't add circles to markerPane, as the not really clickable markers, in normal markerPane, may overlap real clickable markers!

        var pane = map.getPane('coveragePane') || map.createPane('coveragePane');
        pane.style.zIndex = 300; //above tilePane, but below shadowPane
        pane.style.pointerEvents = 'none';  //see https://leafletjs.com/examples/map-panes/
        L.DomUtil.setOpacity(pane, this.options.opacity);

        this._map = map;
        this.requestData();

		if (this.options.scoutLayer) {
		    this.options.scoutLayer.on('dataupdated', this.requestData, this);
		}

    },

    /**
        Remove the 'moveend' event listener and clear all the markers.
        @private
    */
    onRemove: function (map) {
        map.off('moveend', this.requestData, this);
        this.clearLayers();
        this._circles = [];
        this._labels = [];
	    this.outputStatus('');

		if (this.options.scoutLayer) {
		    this.options.scoutLayer.off('dataupdated', this.requestData, this);
		}
    },

    /**
     Redraws the coverage, call this if you change the query, user_id, or even squareScale in options
     @public
    */
    Reset: function () {
	    //need to abort an 'inflight' request
        if (typeof AbortController === 'function' && this._abortController) {
            this._abortController.abort();
        }
    	if (this._currentXHR && this._currentXHR.abort) {
            this._currentXHR.abort();
        }
        this.clearLayers();
        this._circles = [];
        this._labels = [];
        this.requestData();
        return this;
    },

    setOpacity: function (opacity) {
        this.options.opacity = opacity;
        var pane = map.getPane('coveragePane') || map.createPane('coveragePane');
        L.DomUtil.setOpacity(pane, this.options.opacity);
        return this;
    },

    /**
        Send a query request for JSONP data.
        @private
    */
    requestData: function () {
        var zoom = this._map.getZoom(),
        origin = this._map.getCenter(),
	    bounds = map.getBounds(),
	    self = this;

    	if (typeof AbortController === 'function' && this._abortController) {
        	this._abortController.abort();
	    }

        // 1. Basic Zoom Guard
        if (zoom < this.options.minZoom || zoom > this.options.maxZoom) {
            this.clearLayers();
            this._circles = [];
            this._labels = [];
            this.outputStatus('');
            return;
        }

        // 3. Determine Mode (Centisquare still uses legacy API)
        var isHectadMode = !(this.options.squareScale === 'centisquare' || zoom >= 15);

        if (isHectadMode && this.options.scoutLayer) {
            // If the Scout layer isn't currently added to the map, it won't be
            // listening to 'moveend'. We trigger its logic manually.
            if (!this._map.hasLayer(this.options.scoutLayer)) {
                this.options.scoutLayer._onMapMove(null, this._map);
            }

	    bounds = bounds.pad(0.1); //might as well oversample a little

            // Filter the shared cache for squares within the current map bounds
            const cachedSquares = Object.values(this.options.scoutLayer._localSquareCache).filter(sq => {
                // We use a quick bounds check or rely on the Hectad ID
                // Here we check if the square's specific cached entry is within view
                // Note: Scout's _localSquareCache uses Grid Refs as keys (e.g., 'TQ3039')
                // We can approximate visibility or just render all cached items
                // that Scout has loaded for the current view.
                if (!sq.lat)
      	        this._getCenterFromGR(sq); //stores it directly
                return bounds.contains([sq.lat, sq.lng]);
            });

            var resolution = 1000;
            var height = map.distance(bounds.getSouthWest(),bounds.getNorthWest());
            this._extra_class = ((height/resolution) < 8)?'-large':'';

            if (cachedSquares.length > 0) {
                this.parseData({ markers: cachedSquares });
                return;
            }

            // If cache is empty but Scout is loading, parseData will be called
            // eventually when Scout's promises resolve and this function re-triggers.
            this.outputStatus("Syncing with Scout cache...");
            return;
        }

        // --- FALLBACK: Legacy JSONP for Centisquares or when Scout is unavailable ---
        var data = {
	    	olbounds: bounds.toBBoxString(),
		    q: this.options.query || '',
    		user_id: (this.options.user_id > 0)?this.options.user_id:'' //specifically send null as empty string
	    };

        var resolution;
		if (this.options.squareScale == 'centisquare' || zoom >= 15) {
			var url = "https://www.geograph.org.uk/stuff/squares-centi.json.php";

			if (typeof getMyriadLetter != 'undefined') {
				myriads = new Array();
				var vgr = getMyriadLetter( bounds.getSouthWest() );
				if (vgr && vgr.length >0) myriads.push(vgr);
				vgr = getMyriadLetter( bounds.getNorthEast() );
				if (vgr && vgr.length >0) myriads.push(vgr);
				vgr = getMyriadLetter( bounds.getNorthWest() );
				if (vgr && vgr.length >0) myriads.push(vgr);
				vgr = getMyriadLetter( bounds.getSouthEast() );
				if (vgr && vgr.length >0) myriads.push(vgr);
				data.myriads = myriads.join(',');
			}
            resolution = 100;
		} else {
			var url = "https://www.geograph.org.uk/stuff/squares.json.php";
			myriads = new Array();
            resolution = 1000;
		}

        var height = map.distance(bounds.getSouthWest(),bounds.getNorthWest());
        this._extra_class = ((height/resolution) < 8)?'-large':'';


        if (zoom >= this.options.minZoom && zoom <= this.options.maxZoom) {
		    if (window.fetch) {
			    var params = new URLSearchParams(data);
                var self = this;

        		let signal = null;
		        if (typeof AbortController === 'function') {
		            this._abortController = new AbortController();
    		        signal = this._abortController.signal;
	        	}

                fetch(url+'?'+params.toString(), signal ? { signal: signal } : {})
                    .then(response => {
                        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                        return response.json(); // This returns a promise containing the JSON
                    })
                    .then(jsonResponse => {
                        // This is your 'success' callback
                        self.parseData(jsonResponse);
                        self._abortController = null; // Request is finished, clear the handle
                    })
                    .catch(err => {
                        if (err.name === 'AbortError') {
                            return; // Exit silently, as this is expected behavior
                        }
                        console.error("GeographCoverage fetch failed:", err);
                        self.outputStatus("Error loading data.");
                    });

	    	} else {
			    if (this._currentXHR && this._currentXHR.abort) {
		            this._currentXHR.abort();
		        }
    			var ajaxRequest = (window.reqwest)?reqwest:$.ajax;
	            this._currentXHR = ajaxRequest({
            	    url: url,
                    data: data,
			        type: 'json',
            	    success: function (response) { self.parseData(response); self._currentXHR = null; },
                    error: function (err) { self._currentXHR = null; }
                });
	        }
        } else {
            this.clearLayers();
            this._circles = [];
            this._labels = [];
            this.outputStatus('');
        }
 	},

    getMyriadLetter: function(latLng) {
		if (!window.GT_WGS84) //only works if GeoTools2 is loaded!
			return false;
        var gridref = null;
        var wgs84=new GT_WGS84();
        wgs84.setDegrees(latLng.lat,latLng.lng);

        if (wgs84.isIreland2())
            grid=wgs84.getIrish(true);
        else
            grid=wgs84.getOSGB();

        if (grid && grid.status && grid.status == 'OK') {
            var gridref = grid.getGridRef(1);
            var bits = gridref.split(/ /);
            return  bits[0];
        } else
            return false;
    },

    _getCenterFromGR: function(sq) {
        // Quick helper to approximate lat/lng from GR if the Scout cache
        // didn't include explicit coordinates (the Hectad API often doesn't)
        let grid = (sq.gr.length === 6) ? new GT_OSGB() : new GT_Irish();
        grid.parseGridRef(sq.gr);
        // Add 500m to get to the center of the 1km square
        grid.setGridCoordinates(grid.eastings + 500, grid.northings + 500);
        let conv = grid.getWGS84(true);
        sq.lat = conv.latitude, sq.lng = conv.longitude;
    },

    outputStatus: function (text) {
        let ele = document.getElementById('message');
   		if (ele) ele.innerHTML = text;
        return this;
    },

    /**
        Parse the response data and call the addMarker() method for each result.
        @param {Object} response - JSON data
        @private
    */
    parseData: function (data) {

		if (data.error && data.error.length > 0) {
			this.outputStatus(data.error);
			running = false;
			prevZoom = this._map.getZoom();
			return;
		}

		//flag all current markers as old
		for (i in this._labels)
			if (this._labels[i] != null) {
				this._labels[i].old = true;
			}

	        var loaded = 0;

        this.outputStatus("Adding "+(data.markers.length)+" Squares...");

		for (var i = 0; i < data.markers.length; i++) {
			id = data.markers[i].gr+this._extra_class;
			if (this._labels[id] && this._labels[id] != null) {
		        this._labels[id].old = false;
            } else {
				var labelPos = [parseFloat(data.markers[i].lat),parseFloat(data.markers[i].lng)];

				//this._circles[id] = L.circleMarker(labelPos, {radius: 10});

                //if ((data.markers[i].c > 999 && zoom == 13) || (data.markers[i].c > 99 && zoom == 15))
                //      data.markers[i].c = '<div style="transform:rotate(-35deg)">'+data.markers[i].c.toString()+'</div>';
                if (data.markers[i].c > 999)
                    data.markers[i].c = '<div style="font-size:0.7em">'+data.markers[i].c.toString()+'</div>';
                else if (data.markers[i].c > 99)
                    data.markers[i].c = '<div style="font-size:0.85em">'+data.markers[i].c.toString()+'</div>';

                if (data.markers[i].g != undefined && data.markers[i].g==0)
                    data.markers[i].c = '<div style="color:gray">'+data.markers[i].c.toString()+'</div>';

				this._labels[id] = L.marker(labelPos, {
		            icon: L.divIcon({
						iconSize: [40,40],
						html: data.markers[i].c.toString(),
                        className: (data.markers[i].r?'coverage-marker-normal':'coverage-marker-highlight')+this._extra_class
					}),
                    pane: 'coveragePane',
		            title: data.markers[i].gr
		        });

				//this.addLayer(this._circles[id]);
				this.addLayer(this._labels[id]);
		    }
	        loaded=loaded+1;
	    }

		this.outputStatus("Removing Old Squares...");
		for (i in this._labels)
			if (this._labels[i] != null)
				if (this._labels[i].old == true) {
					//this.removeLayer(this._circles[i]);
					this.removeLayer(this._labels[i]);
					this._labels[i] = null;
					this._circles[i] = null;
				}

		if (data.count && data.count.length > 0) {
			if (data.markers.length == data.count) {
				this.outputStatus("Finished, showing "+data.markers.length+" squares.");
			} else {
				this.outputStatus("Finished, showing "+data.markers.length+" of "+data.count+" squares.");
			}
		} else {
			this.outputStatus("Finished, showing "+data.markers.length+" squares.");
		}
		running = false;

    }

});

L.geographCoverage = function (options) {
	return new L.GeographCoverage(options);
};

