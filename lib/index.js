/**
 * Simple MySQL Pool
 *
 * @author 老雷<leizongmin@gmail.com>
 */

var util = require('util');
var events = require('events');
var mysql = require('mysql');
var debug = require('debug')('lei-mysql');

exports = module.exports = MySQLPool;


/**
 * 创建MySQL连接池
 *
 * @param {Object} options
 *  - {String} host       主机地址
 *  - {Number} port       端口
 *  - {Number} database   数据库名
 *  - {String} user       用户名
 *  - {String} password   密码
 *  - {Number} pool       连接池大小
 */
function MySQLPool (options) {
  options = options || {};
  if (!options.host)        throw new Error('Invalid host.');
  if (!(options.port > 0))  throw new Error('Invalid port.');
  if (!options.database)    throw new Error('Invalid database.');
  if (!options.user)        throw new Error('Invalid user.');
  if (!(options.pool > 0))  throw new Error('Invalid pool number.');
  this._options = options;

  var pool = this._pool = mysql.createPool({
    host:             options.host,
    port:             options.port,
    database:         options.database,
    user:             options.user,
    password:         options.password,
    connectionLimit:  options.pool
  });

  debug('Create MySQLPool: pool=%d, host=%s:%s', options.pool, options.host, options.port);
}

// 继承EventEmitter
util.inherits(MySQLPool, events.EventEmitter);

/**
 * 执行查询
 *
 * @param {String} sql
 * @param {Array} params
 * @param {Function} callback
 */
MySQLPool.prototype.query = function () {
  var args = arguments;
  var len = args.length;
  var callback = args[len - 1];

  this._pool.getConnection(function(err, conn) {
    if (err) return callback(err);

    args[len - 1] = function (err) {
      conn.release();
      callback.apply(null, arguments);
    };
    conn.query.apply(conn, args);

    debug('Query: %s', args[0]);
  });
};

/**
 * MySQL字符串转义
 *
 * @param {String} value
 * @return {String}
 */
MySQLPool.prototype.escape = function (value) {
  return SqlStringEscape(value, false, this._options.timezone);
};

/**
 * 当前时间戳
 *
 * @return {Number}
 */
MySQLPool.prototype.timestamp = function () {
  return parseInt(Date.now() / 1000, 10);
};

/**
 * 插入数据
 *
 * @param {String} table
 * @param {Object|Array} data
 * @param {Function} callback
 */
MySQLPool.prototype.insert = function (table, data, callback) {
  var me = this;
  if (!Array.isArray(data)) data = [data];
  if (!(data[0] && typeof data[0] === 'object')) {
    return callback(new Error('Bad data format.'));
  }

  // 取完整的键名
  var fileds = {};
  data.forEach(function (item) {
    for (var i in item) {
      if (!fileds[i]) fileds[i] = true;
    }
  });
  fileds = Object.keys(fileds);

  // 生成数据列表
  var values = [];
  data.forEach(function (item) {
    var line = [];
    fileds.forEach(function (f) {
      line.push(item[f] || '');
    });
    values.push(line);
  });

  // 生成SQL
  var fileds = fileds.map(function (f) {
    return '`' + f + '`';
  });
  var values = values.map(function (line) {
                 return '(' + line.map(function (v) {
                    return me.escape(v);
                 })
                 .join(',') + ')';
               })
               .join(',\n');
  var sql = 'INSERT INTO `' + table + '`(' + fileds + ') VALUES\n' + values;

  me.query(sql, callback);
};

/**
 * 更新数据库
 *
 * @param {String} table
 * @param {String} where
 * @param {Object} data
 * @param {String} tail 可选
 * @param {Function} callback
 */
MySQLPool.prototype.update = function (table, where, data, tail, callback) {
  if (typeof tail === 'function') {
    callback = tail;
    tail = '';
  }

  where = parseCondition(where);

  if (!(data && typeof data === 'object')) {
    return callback(new Error('Data must be an object.'));
  }

  var set = [];
  for (var i in data) {
    set.push('`' + i + '`=' + this.escape(data[i]));
  }
  var sql = 'UPDATE `' + table + '` SET ' + set.join(',') + ' WHERE ' + where + ' ' + tail;

  this.query(sql, callback);
};

/**
 * 删除
 *
 * @param {String} table
 * @param {String} where
 * @param {String} tail 可选
 * @param {Function} callback
 */
MySQLPool.prototype.delete = function (table, where, tail, callback) {
  if (typeof tail === 'function') {
    callback = tail;
    tail = '';
  }

  where = parseCondition(where);

  var sql = 'DELETE FROM `' + table + '` WHERE ' + where + ' ' + tail;

  this.query(sql, callback);
};

/**
 * 查询
 *
 * @param {String} table
 * @param {String} fields 可以是字符串，或者数组：['a', 'b']
 * @param {String} where 可以是字符串，或者前缀式的数组
 * @param {String} tail   可选
 * @param {Function} callback
 */
MySQLPool.prototype.select = function (table, fields, where, tail, callback) {
  if (typeof tail === 'function') {
    callback = tail;
    tail = '';
  }

  if (Array.isArray(fields)) {
    fields = fields.map(function (item) {
      return '`' + item + '`';
    }).join(', ');
  }

  where = parseCondition(where);

  var sql = 'SELECT ' + fields + ' FROM `' + table + '` WHERE ' + where + ' ' + tail;

  this.query(sql, callback);
};

/**
 * 仅查询一条
 *
 * @param {String} table
 * @param {String} fields
 * @param {String} where
 * @param {String} tail
 * @param {Function} callback
 */
MySQLPool.prototype.selectOne = function (table, fields, where, tail, callback) {
  if (typeof tail === 'function') {
    callback = tail;
    tail = '';
  }

  if (tail.toLowerCase().indexOf('limit ') === -1) {
    tail += ' LIMIT 1';
  }

  this.select(table, fields, where, tail, function (err, list) {
    if (err) return callback(err);
    callback(null, list && list[0]);
  });
};


/**
 * MySQL字符串转义（取自mysql模块lib/protocol/SqlString.js）
 */
function SqlStringEscape (val, stringifyObjects, timeZone) {
  if (val === undefined || val === null) {
    return 'NULL';
  }

  switch (typeof val) {
    case 'boolean': return (val) ? 'true' : 'false';
    case 'number': return val+'';
  }

  if (val instanceof Date) {
    val = SqlString.dateToString(val, timeZone || "Z");
  }

  if (Buffer.isBuffer(val)) {
    return SqlString.bufferToString(val);
  }

  if (Array.isArray(val)) {
    return SqlString.arrayToList(val, timeZone);
  }

  if (typeof val === 'object') {
    if (stringifyObjects) {
      val = val.toString();
    } else {
      return SqlString.objectToValues(val, timeZone);
    }
  }

  val = val.replace(/[\0\n\r\b\t\\\'\"\x1a]/g, function(s) {
    switch(s) {
      case "\0": return "\\0";
      case "\n": return "\\n";
      case "\r": return "\\r";
      case "\b": return "\\b";
      case "\t": return "\\t";
      case "\x1a": return "\\Z";
      default: return "\\"+s;
    }
  });
  return "'"+val+"'";
}

/**
 * 解析Where条件
 *
 * @param {String|Array|Object} w
 * @return {String}
 */
function parseCondition (w) {
  if (typeof w === 'string') return w;
  if (Array.isArray(w)) return parseArrayCondition(w);
  if (w && typeof w === 'object') return parseObjectCondition(w);
  return false;
}

function parseArrayCondition (w) {
  if (!Array.isArray(w)) return SqlStringEscape(w);

  switch (w[0]) {
    case '$and':
    case '$or':
      var c = w[0].substr(1).toUpperCase();
      var ret = w.slice(1).map(parseArrayCondition).join(' ' + c + ' ');
      break;
    case '$not':
      var ret = 'NOT ' + parseArrayCondition(w[1]);
      break;
    default:
      if (w.length === 0) var ret = false;
      else if (w.length === 1) var ret = w;
      else if (w.length === 2) var ret = '`' + w[0] + '`=' + parseArrayCondition(w[1]);
      else var ret = '`' + w[0] + '` ' + w[1] + ' ' + parseArrayCondition(w[2]);
  }

  return ' (' + ret + ') ';
}

function parseObjectCondition (w) {
  var list = [];
  for (var i in w) {
    list.push('`' + i + '`=' + SqlStringEscape(w[i]));
  }
  return list.join(' AND ');
}