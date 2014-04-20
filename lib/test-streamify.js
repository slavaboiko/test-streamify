var Transform = require('stream').Transform,
    util = require('util'),
    iconv

if (!Transform) {
  try {
    Transform = require('readable-stream').Transform
  } catch(err) {
    throw new Error('Please "npm install readable-stream"')
  }
}

try { iconv = require('iconv-lite') } catch (err) {}

module.exports = function (opts, cb) {
  var s = new TestStream(opts, cb)

  if (s.cb) s.on('error', s.cb)
  return s
}

module.exports.TestStream = TestStream

function TestStream (opts, cb) {
  opts = opts || {}

  if (opts.inputEncoding) {
    if (!iconv) throw new Error('Please "npm install iconv-lite"')
    if (!iconv.encodingExists(opts.inputEncoding))
      throw new Error('unkown input encoding')
    this.inputEncoding = opts.inputEncoding
  }

  Transform.call(this, opts)

  // assign callback
  this.cb = null
  if (cb) this.cb = cb
  if (typeof opts === 'function') this.cb = opts

  this.newline = opts.newline || '\n'
  this.objectMode = opts.objectMode || false

  this.testStart = opts.testStart || '<##MS##>';
  this.testEnd = opts.testEnd || '<##ME##>';
  this.fieldDelimiter = opts.fieldDelimiter || '{##F##}';
  this.questionDelimiter = opts.questionDelimiter || '{##R##}';
  this.answersDelimiter = opts.answersDelimiter || '~';
  this.inputDelimiter = opts.inputDelimiter || '||';

  this.headers = ['oid', 'code', 'name', 'password', 'timelimit', 'time', 'first', 'group', 'random', 'isTest', 'protocol'];
  this.fields = ['id', 'type', 'nextOk', 'nextFail', 'weight', 'size', 'text', 'answers'];

  this.regInputStart = new RegExp('<%(\\s+)%%(\\s+)', 'g');
  this.regInputEnd = new RegExp('(\\s+)%>', 'g');

  // state
  this.body = []
  this.isQuoted = false
  this.line = []
  this.field = ''
  this.lineNo = 0
  this.columns = []

  // state
  this.test = {
    headers: {},
    questions: []
  };
  this.question = {};
  this.inTest = false;
  this.fieldNo = 0
  this.inHeader = false;
  this.inBody = false;
  this.inQuestion = false;
  this.testNo=0;

  this.started = false;
}

util.inherits(TestStream, Transform)

TestStream.prototype._transform = function (chunk, encoding, done) {
  if (this.inputEncoding)
    chunk = iconv.fromEncoding(chunk, this.inputEncoding)
  
  chunk = chunk.toString()

  try {
    this._parse(chunk)
    done()
  } catch (err) {
    done(err)
  }
}

TestStream.prototype._parse = function (data) {
  var c,i=0

  while (i < data.length) {
    c = data.charAt(i)
     // handle start-test token
    if (!this.inTest && this._isToken(data, this.testStart, i)) {
      i += this.testStart.length;
      this.inTest = true;
      this.inHeader = true;
      this.started = true;
      continue;
    }

    // handle end-test token
    if (this.inTest && this._isToken(data, this.testEnd, i)) {
      i += this.testEnd.length;
      this._test();
      this.inTest = false;
      continue;
    }

    // handle field delimiter
    if ((this.inHeader || this.inQuestion) && this._isToken(data, this.fieldDelimiter, i)) {
      // go back before field
      this._field();
      i += this.fieldDelimiter.length;
      this._nextField();
      continue;
    }

    // handle question delimiter
    if (this.inQuestion && this._isToken(data, this.questionDelimiter, i)) {
      this._field();
      i += this.questionDelimiter.length;
      this._question();
      continue;
    }

    if (this.inQuestion && (c == '\r' || c == '\n')) {
      
      // not text fields
      if (this.fieldNo < 6) {
        i++;
      }
      // text field, replace with html line feed
      else {
        this.field += '<br>';
        i++;
      }
      continue;
    }

    // handle newlines after header
    if (this.inHeader && c === this.newline) {
      this._field();
      this.inHeader = false;
      this.inBody = true;
      this.inQuestion = true;
      this._reset();
      continue
    } else if (this.inHeader && (c + data.charAt(i + 1)) === this.newline) {
      this._field();
      this.inHeader = false;
      this.inBody = true;
      this.inQuestion = true;
      this._reset();
      // skip over \n of \r\n
      i += 1
      continue
    }

    if (!this.started && this.field.length > this.testStart.length) {
      throw new Error('Invalid test file format');
    }

    // append current char to field string
    this.field += c
    i++
  }
}

TestStream.prototype._field = function () {
  if (this.inHeader) {
    var headerName = this.headers[this.fieldNo];
    var value = this.field;

    if (this.fieldNo == 8 || this.fieldNo == 9 || this.fieldNo == 10) {
      value = (value == 'ON') ? true : false;
    } else if (this.fieldNo == 0 || this.fieldNo == 7 || this.fieldNo == 4) {
      value = parseInt(value);
    }

    this.test.headers[headerName] = value;
  } else if (this.inQuestion) {
    var fieldName = this.fields[this.fieldNo];
    var value = this.field;

    // answers && rightAnswers
    if (this.fieldNo == 7) {
      value = [];

      if (this.field.trim().length > 0) {
        var answersRaw = this.field.split(this.answersDelimiter);
        answersRaw.forEach(function(val, key){
          value.push({text: val, isRight: false})
        });
      } 
    }
    else if (this.fieldNo == 8) {
        var rightAnswers = this.field.split(this.question.type == 'qinput' ? this.inputDelimiter : this.answersDelimiter);

        for (var i = 0; i < rightAnswers.length; i++) {
          var index = parseInt(rightAnswers[i]) - 1;

          if (this.question.type == 'qinput') {
            var text = rightAnswers[i].replace(/\`/g,'');
            this.question.answers.push({text: text, isRight: true});
          } else {
            if (this.question.answers[index]) {
              this.question.answers[index].isRight = true
            }
          }
        }
      return;
    }

    this.question[fieldName] = value;
  }
}

TestStream.prototype._question = function () {
    if (this.question.type != 'qvars1') {

      if (this.question.type == 'qmulti') {
        this.question.text = this.question.text
        .replace(this.regInputStart, "<span class='qmulti-answer'>")
        .replace(this.regInputEnd, "</span>");
      }

      this.test.questions.push(this.question);
    }
    this._reset();
}

TestStream.prototype._test = function () {
  // emit the parsed line as an array if in object mode
  // or as a stringified array (default)
  if (this.objectMode) {
    this.push(this.test)
  } else {
    this.push(JSON.stringify(this.test) + '\n')
  }

  if (this.cb) this.body.push(this.test)
  this.testNo += 1

  // reset test state
  this._resetTest()
}

TestStream.prototype._reset = function () {
  this.field = ''
  this.fieldNo = 0
  this.question = {}
}

TestStream.prototype._nextField = function () {
  this.field = ''
  this.fieldNo++
}


TestStream.prototype._resetTest = function () {
  this.test = {
    headers: {},
    questions: []
  };
  this.body = [];
  this.inTest = false;
  this.inHeader = false;
  this.inBody = false;
  this.inQuestion = false;
  this._reset();
}

TestStream.prototype._flush = function (fn) {
  // flush last line
  try {
    if (this.cb) this.cb(null, this.body)
    fn()
  } catch(err) {
    fn(err)
  }
}


TestStream.prototype._isToken = function (data, token, i) {
  // test for token
  try {
    return (data.substring(i, i+token.length) == token) ? true : false;
  } catch(err) {
    console.log(err);
    return false;
  }
}

