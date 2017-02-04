var templates = require('./hbs');
var lastSearchResults = {};
var lastSearchHitCount = 0;

module.exports = [
  {
    regEx: /search (album|artist|track|playlist)?(.*)/,
    help: 'Searches Spotify for the given query',
    execute: function(message, db) {
      var matches = message.text.match(this.regEx);
      var query = matches[2];
      var types = [];
      if (matches[1]) {
        types.push(matches[1])
      } else {
        types = types.concat(['album', 'artist', 'track', 'playlist'])
      }

      db.logger.info('Searching for "%s" in [%s]', query, types.join(', '));

      db.spotify.search(query, types, {
        limit: db.settings.limit,
        offset: 0
      })
      .then(function(data) {
        lastSearchResults = {};
        var maxCount = db.settings.limit;
        var typesCount = types.length;
        var hit = 0;

        while(maxCount > 0 && typesCount > 0) {
          for(var t = 0; t < typesCount; t++) {
            var type = types[t] + 's';
            if (!lastSearchResults[type]) {
              lastSearchResults[type] = {
                items: [],
                total: data.body[type].total
              };
            }
            var length = lastSearchResults[type].items.length;

            if (data.body[type].items[length]) {
              lastSearchResults[type].items[length] = data.body[type].items[length];
              maxCount--;
            } else {
              types.splice(t, 1);
              typesCount--;
            }
          }
        }

        for(var type in lastSearchResults) {
          for(var i = 0; i < lastSearchResults[type].items.length; i++) {
            lastSearchResults[type].items[i].hit = hit = hit+1;
          }
        }

        lastSearchHitCount = hit;
        if (lastSearchResults.albums && lastSearchResults.albums.items.length > 0) {
          return db.spotify.getAlbums(lastSearchResults.albums.items.map(
            function(album) {
              return album.id;
            })
          );
        } else {
          return null;
        }
      })
      .then(function(data) {
        if (data && data.body) {
          for(var i = 0; i < data.body.albums.length; i++) {
            Object.assign(lastSearchResults.albums.items[i], data.body.albums[i]);
          }
        }
        db.post(message.channel, templates.search(lastSearchResults));
      })
      .catch(function(err) {
        db.logger.error(err);
      });
    }
  },
  {
    regEx: /play (\d+)/,
    help: 'Plays a Spotify resource from the last search',
    execute: function(message, db) {
      var matches = message.text.match(this.regEx);
      var id = parseInt(matches[1]);

      if (id == 0 || id > lastSearchHitCount) {
        db.post(message.channel, templates.play());
        return;
      }

      db.logger.info('Clearing tracklist');
      var item;
      db.mopidy.tracklist.clear()
      .then(function() {
        db.emit('tracklist:clear', message);
        for(var type in lastSearchResults) {
          for(var i = 0; i < lastSearchResults[type].items.length; i++) {
            if (lastSearchResults[type].items[i].hit === id) {
              item = lastSearchResults[type].items[i];
              db.logger.info('Adding %s to tracklist', item.uri);
              return db.mopidy.tracklist.add(null,null,item.uri);
            }
          }
        }
        throw new Error('No search result found');
      })
      .then(function(tracks) {
        db.emit('tracklist:add', message, tracks);
        return db.mopidy.playback.play();
      })
      .catch(function() {})
      .done(function() {
        db.post(message.channel, templates.play({uri: item.uri}));
      });
    }
  },
  {
    regEx: /queue (\d+)( \d+)?/,
    help: 'Enqueues a Spotify resource from the last search at an optional position in the tracklist',
    execute: function(message, db) {
      var matches = message.text.match(this.regEx);
      var id = parseInt(matches[1]);

      if (id == 0 || id > lastSearchHitCount) {
        db.post(message.channel, templates.play());
        return;
      }

      var position = null;
      if (matches[2]) {
        position = parseInt(matches[2]);
      }

      for(var type in lastSearchResults) {
        for(var i = 0; i < lastSearchResults[type].items.length; i++) {
          if (lastSearchResults[type].items[i].hit === id) {
            var item = lastSearchResults[type].items[i];
            db.logger.info('Adding %s to tracklist', item.uri);
            db.mopidy.tracklist.add(null,position,item.uri)
            .done(function(tracks) {
              db.emit('tracklist:add', message, tracks);
              db.post(message.channel, templates.play({uri: item.uri}));
            });
          }
        }
      }
    }
  },
  {
    regEx: /play ([^\s]+)/,
    help: 'Plays a URI',
    execute: function(message, db) {
      var matches = message.text.match(this.regEx);
      var uri = matches[1];
      db.logger.info('Clearing tracklist');
      db.mopidy.tracklist.clear()
      .then(function() {
        db.emit('tracklist:clear', message);
        db.logger.info('Adding %s to tracklist', uri);
        return db.mopidy.tracklist.add(null,null,uri);
      })
      .then(function(tracks) {
        db.emit('tracklist:add', message, tracks);
        return db.mopidy.playback.play();
      })
      .done(function() {
        db.post(message.channel, templates.play({uri: uri}));
      })
    }
  },
  {
    regEx: /queue ([^\s]+)( \d+)?/,
    help: 'Enqueues a URI at an optional position in the tracklist',
    execute: function(message, db) {
      var matches = message.text.match(this.regEx);
      var uri = matches[1];

      var position = null;
      if (matches[2]) {
        position = parseInt(matches[2]);
      }

      db.logger.info('Adding %s to tracklist', uri);
      db.mopidy.tracklist.add(null,position,uri)
      .done(function(tracks) {
        db.emit('tracklist:add', message, tracks);
        db.post(message.channel, templates.play({uri: uri}));
      });
    }
  },
  {
    regEx: /(tracks|list)/,
    help: 'Prints out the current tracklist',
    execute: function(message, db) {

      if (db.state.random || (db.state.repeat && db.state.single) || db.state.single) {
        db.logger.info('Getting next track');
        db.mopidy.tracklist.nextTrack(db.state.tlTrack)
        .done(function(tlTrack) {
          if (db.settings.history === true) {
            tlTrack.history = db.getHistoryState(tlTrack.tlid);
          }

          db.post(message.channel, templates.next_track(tlTrack));
        });
        return;
      }

      db.logger.info('Getting current tracklist');
      var index, length;
      db.mopidy.tracklist.index()
      .then(function(value) {
        if (value === null) {
          throw new Error('Current index not available');
        }
        index = value;
        return db.mopidy.tracklist.getLength();
      })
      .then(function(value) {
        length = value;
        return db.mopidy.tracklist.slice(index, index+10);
      })
      .catch(function(){})
      .done(function(tlTracks) {
        tlTracks = tlTracks || [];
        tlTracks = tlTracks.map(function(currentValue, i){
          currentValue.index = index + i;
          if (db.settings.history === true) {
            currentValue.history = db.getHistoryState(currentValue.tlid);
          }
          return currentValue;
        });
        db.post(message.channel, templates.tracks({tlTracks: tlTracks, length: length}));
      });
    }
  },
  {
    regEx: /(clear|clean)/,
    help: 'Clears the tracklist',
    execute: function(message, db) {
      db.logger.info('Clearing current tracklist');
      db.mopidy.tracklist.clear()
      .done(function() {
        db.emit('tracklist:clear', message);
      });
    }
  },
  {
    regEx: /(next|skip)/,
    help: 'Plays the next track from the tracklist',
    execute: function(message, db) {
      db.logger.info('Playing next track');
      db.mopidy.playback.next();
    }
  },
  {
    regEx: /prev/,
    help: 'Plays the previous track from the tracklist',
    execute: function(message, db) {
      db.logger.info('Playing previous track');
      db.mopidy.playback.previous();
    }
  },
  {
    regEx: /pause/,
    help: 'Pauses the current tracks',
    execute: function(message, db) {
      db.logger.info('Pausing current track');
      db.mopidy.playback.pause();
    }
  },
  {
    regEx: /resume/,
    help: 'Resumes the current tracks',
    execute: function(message, db) {
      db.logger.info('Resuming current track');
      db.mopidy.playback.resume();
    }
  },
  {
    regEx: /stop/,
    help: 'Stops playback',
    execute: function(message, db) {
      db.logger.info('Stopping playback');
      db.mopidy.playback.stop();
    }
  },
  {
    regEx: /play/,
    help: 'Plays current tracklist',
    execute: function(message, db) {
      db.logger.info('Playing tracklist');
      db.mopidy.playback.play();
    }
  },
  {
    regEx: /mode (consume|random|repeat|single)/,
    help: 'Gets a specific mode enabled state',
    execute: function(message, db) {
      var mode = message.text.match(this.regEx)[1];
      db.logger.info('Getting %s mode', mode);
      mode = mode.charAt(0).toUpperCase() + mode.slice(1);
      db.mopidy.tracklist['get' + mode]()
      .done(function(value) {
        db.post(message.channel, templates.mode({mode: mode, value: value}));
      });
    }
  },
  {
    regEx: /mode (consume|random|repeat|single) (true|false)/,
    help: 'Sets a specific mode enabled state',
    execute: function(message, db) {
      var matches = message.text.match(this.regEx);
      var mode = matches[1];
      var value = matches[2];
      db.logger.info('Setting %s mode to %s', mode, value);
      mode = mode.charAt(0).toUpperCase() + mode.slice(1);
      db.mopidy.tracklist['set' + mode](value === 'true')
      .done(function() {
        db.emitCommand('mode ' + mode.toLowerCase(), message);
      });
    }
  },
  {
    regEx: /shuffle/,
    help: 'Shuffles current tracklist',
    execute: function(message, db) {
      var index;
      db.mopidy.tracklist.index()
      .then(function(value){
        if (value === null) {
          throw new Error('Current index not available');
        }
        index = value;
        return db.mopidy.tracklist.getLength();
      })
      .then(function(length){
        db.logger.info('Shuffling tracklist from %d to %d', index+1, length);
        return db.mopidy.tracklist.shuffle(index+1, length);
      })
      .catch(function(){})
      .done(function() {
        db.emitCommand('tracks', message);
      });
    }
  },
  {
    regEx: /(vol|volume)/,
    help: 'Gets the volume',
    execute: function(message, db) {
      db.logger.info('Getting volume');
      db.mopidy.mixer.getVolume()
      .done(function(volume) {
        db.post(message.channel, templates.volume({volume: volume}));
      });
    }
  },
  {
    regEx: /(vol|volume) (\d{1,3})/,
    help: 'Sets the volume',
    execute: function(message, db) {
      var matches = message.text.match(this.regEx);
      db.logger.info('Setting volume to %d', matches[2]);
      db.mopidy.mixer.setVolume(parseInt(matches[2]))
      .done(function(volume) {
        db.emitCommand('vol', message);
      });
    }
  },
  {
    regEx: /(vol|volume) (up|down)/,
    help: 'Increases / Decreases the volume',
    execute: function(message, db) {
      var matches = message.text.match(this.regEx);
      var volume = parseInt(db.state.volume);
      volume += matches[2] === 'up' ? 5 : -5;
      db.logger.info('Setting volume to %d', volume);
      db.mopidy.mixer.setVolume(volume)
      .done(function(volume) {
        db.emitCommand('vol', message);
      });
    }
  },
]
