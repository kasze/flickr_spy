var sys = require("sys"), 
  http = require("http"),
  posix = require("posix"),
  FlickrAPI= require('./vendor/flickr/lib/flickr').FlickrAPI,
  underscore = require("./vendor/underscore/underscore"),
  throttle = require("./vendor/throttle/lib/throttle"),
  static = require("./vendor/static/static").static,
  ws = require("./vendor/ws/lib/ws"),
  username = process.ARGV[2] || "ncr";
  
  
function nano(template, data) {
  return template.replace(/\{([\w\.]*)}/g, function (str, key) {
    var keys = key.split("."), value = data[keys.shift()];
    keys.forEach(function (key) { value = value[key] });
    return value;
  });
}



sys.puts("* Flickr Spy: " + username);
flickr= new FlickrAPI("3f6ad5daec2a6a194c54f19ea38dbe5d");

http.createServer(function (req, res) {
  var path = req.url;
  sys.debug(path);
  static("public", req, res);
}).listen(3000);

ws.createServer(function (websocket) {
  websocket.addListener("connect", function (resource) {
    sys.debug("connect: " + resource.slice(1));
    spy_emitter(resource.slice(1)).addListener("data", function (data) {
      websocket.send(JSON.stringify(data));
    }).addListener("close", function () {
      websocket.close();
    })
  }).addListener("receive", function (data) {
    sys.debug("receive: " + data);
  }).addListener("close", function () {
    sys.debug("close")
  });
}).listen(8080);

var spy_emitter = function (username) {
  var emitter = new process.EventEmitter(),
    url = "http://flickr.com/photos/" + username;

  // 1. Find my id
  flickr.urls.lookupUser(url).addCallback(function (user) {
    var my_user_id = user.id;

    // 2. Grab my contact list
    flickr.contacts.getPublicList(my_user_id).addCallback(function (contacts) {
        var user_ids = [];
        if( contacts.contact ) {
            contacts.contact.forEach(function (c) {
              user_ids.push(c.nsid);
            });        
        }
        var contact_ids= user_ids;
        var t1 = throttle.create(3),
        todo1 = user_ids.length, done1 = 0,
        todo2 = 0, done2 = 0;
      
      // 3. Iterate over my contacts
      user_ids.forEach(function (user_id) {
        t1.run(function () {
          
          // 4. Find latest commented photos by my contacts
          flickr.feeds.photosComments(user_id).addCallback(function (photo_comments) {
            var t2 = throttle.create(3);
            done1++;
            var photo_ids= [];
            photo_comments.items.forEach(function (p) {
              var m = p.link.match(/(\d+)\/comment\d+\/$/); // won't match sets
              if (m) { 
                var photo_id = m[1];
                if (photo_ids.indexOf(photo_id) == -1) {
                  photo_ids.push(photo_id);
                }
              }  
            });            
            todo2 += photo_ids.length;
            
            function finalize() {
              done2++;
              if (todo1 == done1 && todo2 == done2) {
                sys.debug("callback: getList: close")
                emitter.emit("close");
              }
              t2.free();
            };

            // 5. Iterate over latest commented photos
            photo_ids.forEach(function (photo_id) {
              t2.run(function () {
                
                // 6. Get more detailed photo info
                flickr.photos.getInfo(photo_id).addCallback(function (photo) {
                  if(!photo.owner){sys.debug(sys.inspect(photo))} // fails sometimes
                  
                  // 7. Skip my photos and photos of my contacts
                  if (photo.owner.nsid != my_user_id && !_.include(contact_ids, photo.owner.nsid)) {
                  
                    // 8. Get full comment list for a photo
                    flickr.photos.comments.getList(photo_id).addCallback(function (user_ids) {
                      
                      // 9. Skip if I already commented
                      if(!_.include(user_ids, my_user_id)) {

                        var photo_url  = nano("http://farm{farm}.static.flickr.com/{server}/{id}_{secret}.jpg", photo);
                        var photo_page = nano("http://www.flickr.com/photos/{owner.nsid}/{id}", photo);
                        
                        sys.debug("" + photo.owner.nsid + ": " + photo.id)
                        
                        // 10. Emit photo and my contacts that commented on that photo
                        emitter.emit("data", {page: photo_page, image: photo_url, contact_ids: _.intersect(contact_ids, user_ids)});
                      }
                      finalize();
                    }).addErrback(function (data) {
                      // do not emit error from this loop
                      sys.debug("errback: getList: " + data.message);
                      finalize();
                    });
                  } else {
                    finalize();
                  }
                }).addErrback(function (data) {
                  finalize();
                  sys.debug("errback: geInfo: " + data.message);
                });   
                
              });
            });
            
            t1.free();
          }).addErrback(function (data) {
            emitter.emit("error");
            sys.debug("errback: photosComments: " + data.message);
          });
        });
      });
    }).addErrback(function (data) {
      emitter.emit("error");
      sys.debug("errback: getPublicList: " + data.message);
    });
    
    
  }).addErrback(function (data) {
    emitter.emit("error");
    sys.debug("errback: lookupUser: " + data.message);
  });
  return emitter;
};

var spy_promise = function (username) {
  var promise = new process.Promise();
  var result = [];
  spy_emitter(username).addListener("data", function (data) {
    result.push(data);
  }).addListener("close", function () {
    promise.emitSuccess(result);
  }).addListener("error", function (data) {
    promise.emitError(data);
  })
  return promise;
}

