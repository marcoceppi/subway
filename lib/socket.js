var bcrypt = require('bcrypt'),
  mongoose = require('mongoose'),
  IRCLink = require('./irclink');
  
// establish models
var User = mongoose.model('User');
var Connection = mongoose.model('Connection');
var Message = mongoose.model('Message');

module.exports = function(socket, connections) {
  var current_user;
  
  socket.on('getDatabaseState', function(){
    socket.emit('databaseState', {state: mongoose.connection.readyState});
  });
  
  socket.on('register', function(data) {
    bcrypt.genSalt(10, function(err, salt) {
      bcrypt.hash(data.password, salt, function(err, hash) {
        // Store hash in your password DB.
        var user = new User();
        user.username = data.username;
        user.password = hash;
        user.save();
        socket.emit('register_success', {username: user.username});
        current_user = user;
      });
    });
  });

  socket.on('login', function(data) {
    User.findOne({username: data.username}, function(err, user) {
      if(user) {
        bcrypt.compare(data.password, user.password, function(err, res) {
          if(res === true) {
            var exists;
            current_user = user;
            if(connections[user.username] !== undefined) {
              exists = true;
            } else {
              exists = false;
            }
            socket.emit('login_success', {username: user.username, exists: exists});
          } else {
            socket.emit('login_error', {message: 'Wrong password'});
          }
        });
      }
    });
  });

  socket.on('connect', function(data) {
    var connection;
    if(current_user) {
      connection = connections[current_user.username];
    }

    if(connection === undefined) {
      connection[data.server] = new IRCLink(data.server, data.port,
        data.secure, data.selfSigned, data.nick, data.realName,
        data.password, data.rejoin, data.away);

      // save this connection
      if(current_user) {
        var conn_obj = { user: current_user.username };
        // bind this socket to the proper IRC instance
        for( srv in connection ) {
          connection[srv].associateUser(current_user.username);
          // Technically we should only have one? but just in case I go
          // crazy in the future, make sure this works for all the conns
          // CRAP, TODO: don't use data., use the data from connection[srv]
          conn_obj.servers[data.server] = {
            hostname: data.server,
            port: data.port || (data.secure ? 6697 : 6667),
            ssl: data.secure,
            rejoin: data.rejoin,
            away: data.away,
            realName: data.realName,
            selfSigned: data.selfSigned,
            channels: data.channels,
            nick: data.nick,
            password: data.password
          };
        }

        var conn = new Connection(conn_obj);
        conn.save();
        connections[current_user.username] = connection;
      }
    } else {
      socket.emit('restore_connection', {nick: connection.client.nick,
        server: connection.client.opt.server, channels: connection.client.chans});
    }

    // register this socket with our user's IRC connection
    connection.addSocket(socket);

    // Socket events sent FROM the front-end
    socket.on('join', function(name, server) {
      if (name[0] != '#')
        name = '#' + name;

      connection[server].client.join(name);
    });

    socket.on('part_pm', function(name, server){
      if(connection.clients.chans[name.toLowerCase()] !== undefined){
        delete connection.clients.chans[name.toLowerCase()];
      }
    });

    socket.on('part', function(name, server) {
      if (name[0] != '#')
        name = '#' + name;
      
      connection.client.part(name);
      if(current_user){
        // update the user's connection / channel list
        Connection.update({ user: current_user.username }, { $pull: { channels: name.toLowerCase() } }, function(err) {});
      }
    });

    socket.on('say', function(data) {
      connection.client.say(data.target, data.message);
      socket.emit('message', {to:data.target.toLowerCase(), from: connection.client.nick, text:data.message});
      if(current_user){
        connection.logMessage(data.target, connection.client.nick, data.message);
      }
    });

    socket.on('action', function(data) {
      connection.client.action(data.target, data.message);
      socket.emit('message', {
        to: data.target.toLowerCase(),
        from: connection.client.nick,
        text: '\u0001ACTION ' + data.message}
      );
    });

    socket.on('topic', function(data){
      connection.client.send('TOPIC ', data.name, data.topic);
    });

    socket.on('nick', function(data){
      connection.client.send('NICK', data.nick);
      connection.client.nick = data.nick;
      connection.client.opt.nick = client.nick;
    });

    socket.on('command', function(text) {
      connection.client.send(text);
    });

    socket.on('disconnect', function() {
      if(!current_user){
        // not logged in, drop this session
        connection.disconnect();
      } else {
        // keep the session alive, remove this socket, and clear unreads
        connection.removeSocket(socket);
        connection.clearUnreads();
      }
    });

    socket.on('getOldMessages', function(data){
      if (current_user) {
        var query = Message.find({channel: data.channelName.toLowerCase(),
          server: connection.server.toLowerCase(), linkedto: current_user.username});

        query.limit(data.amount);
        query.sort('date', -1);
        query.skip(data.skip);

        query.exec(function (err, results) {
          if(results) {
            var returnData = {};
            if(results && results.length > 0) {
              returnData['name'] = data.channelName.toLowerCase();
              returnData['messages'] = results;
            }
            socket.emit('oldMessages', returnData);
          }
        });
      }
    });
  });
}
