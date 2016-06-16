require('firebase');
var parse = require('url-parse');
var uuid = require('uuid');

if (typeof AFRAME === 'undefined') {
  throw new Error('Component attempted to register before AFRAME was available.');
}

var channelQueryParam = parse(location.href, true).query['aframe-firebase-channel'];

/**
 * Firebase system.
 */
AFRAME.registerSystem('firebase', {
  init: function () {
    var database;
    var sceneEl = this.sceneEl;
    // Cannot use getComputedAttribute since component not yet attached,
    // so set property defaults in this method instead of in schema.
    var config = sceneEl.getAttribute('firebase');
    var self = this;

    this.broadcastingEntities = {};
    this.clientId = uuid.v4();
    this.entities = {};

    // Get config.
    if (!(config instanceof Object)) {
      config = AFRAME.utils.styleParser.parse(config);
    }
    if (!config) { return; }

    // Set up Firebase.
    this.channel = channelQueryParam || config.channel || 'default';
    this.firebase = firebase.initializeApp(config);
    var database = this.database = firebase.database().ref(this.channel);

    this.broadcastingEntities = {};
    this.entities = {};
    this.interval = config.interval || 10;

    // Firebase handlers.
    database.child('entities').once('value', function (snapshot) {
      self.handleInitialSync(snapshot.val() || {});
    });

    database.child('entities').on('child_added', function (data) {
      self.handleEntityAdded(data.key, data.val());
    });

    database.child('entities').on('child_changed', function (data) {
      self.handleEntityChanged(data.key, data.val());
    });

    database.child('entities').on('child_removed', function (data) {
      self.handleEntityRemoved(data.key);
    });
  },

  /**
   * Initial sync.
   */
  handleInitialSync: function (data) {
    var self = this;
    var broadcastingEntities = this.broadcastingEntities;
    Object.keys(data).forEach(function (entityId) {
      if (broadcastingEntities[entityId]) { return; }
      self.handleEntityAdded(entityId, data[entityId]);
    });
  },

  /**
   * Entity added.
   */
  handleEntityAdded: function (id, data) {
    // Already added.
    if (this.entities[id] || this.broadcastingEntities[id]) { return; }

    // Get or create entity.
    var created;
    var entity;
    if (data['firebase-broadcast'].shared === true && data.id) {
      entity = this.sceneEl.querySelector('#' + data.id);
    } else {
      entity = document.createElement('a-entity');
      created = true;
    }
    this.entities[id] = entity;

    // Components.
    Object.keys(data).forEach(function setComponent (componentName) {
      // Don't sync `firebase-broadcast`, it will wipe components.
      if (componentName === 'firebase-broadcast' || componentName === 'parentId') { return; }
      setAttribute(entity, componentName, data[componentName]);
    });

    // Find parent node and append.
    var parentEl = this.entities[data.parentId] || this.sceneEl;
    delete data.parentId;
    if (created) { parentEl.appendChild(entity); }
  },

  /**
   * Entity updated.
   */
  handleEntityChanged: function (id, components) {
    // Don't sync if already broadcasting to self-updating loops.
    if (this.broadcastingEntities[id]) { return; }

    var entity = this.entities[id];
    Object.keys(components).forEach(function setComponent (componentName) {
      if (componentName === 'parentId') { return; }
      setAttribute(entity, componentName, components[componentName]);
    });
  },

  /**
   * Entity removed. Detach.
   */
  handleEntityRemoved: function (id) {
    var entity = this.entities[id];
    if (!entity) { return; }
    entity.parentNode.removeChild(entity);
    delete this.entities[id];
  },

  /**
   * Register.
   */
  registerBroadcast: function (el) {
    var broadcastData = el.getComputedAttribute('firebase-broadcast');
    var broadcastingEntities = this.broadcastingEntities;
    var database = this.database;
    var id = el.getAttribute('id');
    broadcastingEntities[id] = el;

    // Check if entity is owned by another client.
    if (broadcastData.shared) {
      var upstreamEntity = database.child('entities').orderByChild('id').equalTo(id);
      if (upstreamEntity.owner) { return; }
    }

    // Initialize entry, get assigned a Firebase ID.
    var id = database.child('entities').push().key;
    el.setAttribute('firebase-broadcast', 'id', id);

    // Remove entry when client disconnects if not shared.
    database.child('entities').child(id).onDisconnect().remove();
  },

  /**
   * Broadcast each entity, building each entity's data.
   */
  tick: function (time) {
    if (!this.firebase) { return; }

    var broadcastingEntities = this.broadcastingEntities;
    var clientId = this.clientId;
    var database = this.database;
    var sceneEl = this.sceneEl;

    // Interval.
    if (time - this.time < this.interval) { return; }
    this.time = time;

    Object.keys(broadcastingEntities).forEach(function broadcastEntity (id) {
      var el = broadcastingEntities[id];
      var broadcastData = el.getComputedAttribute('firebase-broadcast');
      var components = broadcastData.components;
      var data = {};

      // Keep track of explicit ID in case of shared objects.
      data['id'] = el.getAttribute('id');
      data['firebase-broadcast'] = {
        shared: broadcastData.shared
      };

      // Check if shared entity is unclaimed. Take it if not.
      if (broadcastData.shared && !broadcastData.owner) {
        el.setAttribute('firebase-broadcast', 'owner', clientId);
        broadcastData.owner = clientId;
        data['firebase-broadcast'].owner = clientId;
      }

      // Check if entity is owned by another client.
      if (broadcastData.shared && broadcastData.owner !== clientId) { return; }

      // Add components to broadcast once.
      if (!el.firebaseBroadcastOnce && broadcastData.componentsOnce) {
        components = components.concat(broadcastData.componentsOnce);
        el.firebaseBroadcastOnce = true;
      }

      // Parent.
      if (el.parentNode && el.parentNode !== sceneEl) {
        var parentBroadcastData = el.parentNode.getAttribute('firebase-broadcast');
        if (!parentBroadcastData) { return; }  // Wait for parent to initialize.
        data.parentId = parentBroadcastData.id;
      }

      // Build data.
      components.forEach(function getData (componentName) {
        data[componentName] = getComputedAttribute(el, componentName);
      });

      // Broadcast data.
      database.child('entities/' + id).update(data);
    });
  }
});

/**
 * Scene Firebase data.
 */

AFRAME.registerComponent('firebase', {
  schema: {
    apiKey: {type: 'string'},
    authDomain: {type: 'string'},
    channel: {type: 'string'},
    databaseURL: {type: 'string'},
    interval: {type: 'number'},
    storageBucket: {type: 'string'}
  }
});

/**
 * Entity broadcast data.
 */
AFRAME.registerComponent('firebase-broadcast', {
  schema: {
    id: {default: ''},  // Provided by Firebase.
    components: {default: ['position', 'rotation']},
    componentsOnce: {default: [], type: 'array'},
    shared: {default: false},
    owner: {default: ''}
  },

  init: function () {
    var data = this.data;
    var el = this.el;
    var system = el.sceneEl.systems.firebase;
    if (data.components.length) { system.registerBroadcast(el); }
  }
});

/**
 * Get attribute that handles individual component properties.
 */
function getComputedAttribute (el, attribute) {
  // Handle individual component property.
  var split = attribute.split('|');
  if (split.length === 2) {
    return el.getComputedAttribute(split[0])[split[1]];
  }
  return el.getComputedAttribute(attribute);
}

/**
 * Set attribute that handles individual component properties.
 */
function setAttribute (el, attribute, value) {
  // Handle individual component property.
  var split = attribute.split('|');
  if (split.length === 2) {
    el.setAttribute(split[0], split[1], value);
    return;
  }
  el.setAttribute(attribute, value);
}
