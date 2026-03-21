/**
 * Turndown - HTML to Markdown converter
 * Minified version for Chrome Extension
 * Based on https://github.com/mixmark-io/turndown
 * License: MIT
 */
(function(global){
  'use strict';

  function extend(destination){
    for(var i=1;i<arguments.length;i++){
      var source=arguments[i];
      for(var key in source){
        if(source.hasOwnProperty(key))destination[key]=source[key];
      }
    }
    return destination;
  }

  function repeat(character,count){
    return Array(count+1).join(character);
  }

  function trimLeadingNewlines(string){
    return string.replace(/^\n*/,'');
  }

  function trimTrailingNewlines(string){
    var indexEnd=string.length;
    while(indexEnd>0&&string[indexEnd-1]==='\n')indexEnd--;
    return string.substring(0,indexEnd);
  }

  var blockElements=['ADDRESS','ARTICLE','ASIDE','AUDIO','BLOCKQUOTE','BODY','CANVAS',
    'CENTER','DD','DIR','DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER',
    'FORM','FRAMESET','H1','H2','H3','H4','H5','H6','HEADER','HGROUP','HR','HTML',
    'ISINDEX','LI','MAIN','MENU','NAV','NOFRAMES','NOSCRIPT','OL','OUTPUT','P','PRE',
    'SECTION','TABLE','TBODY','TD','TFOOT','TH','THEAD','TR','UL'];

  function isBlock(node){
    return blockElements.indexOf(node.nodeName)!==-1;
  }

  function isVoid(node){
    return['AREA','BASE','BR','COL','COMMAND','EMBED','HR','IMG','INPUT','KEYGEN',
      'LINK','META','PARAM','SOURCE','TRACK','WBR'].indexOf(node.nodeName)!==-1;
  }

  function hasVoid(node){
    return node.querySelector&&node.querySelector('area,base,br,col,command,embed,hr,img,input,keygen,link,meta,param,source,track,wbr');
  }

  var rules={};

  rules.paragraph={
    filter:'p',
    replacement:function(content){
      return'\n\n'+content+'\n\n';
    }
  };

  rules.lineBreak={
    filter:'br',
    replacement:function(content,node,options){
      return options.br+'\n';
    }
  };

  rules.heading={
    filter:['h1','h2','h3','h4','h5','h6'],
    replacement:function(content,node,options){
      var hLevel=Number(node.nodeName.charAt(1));
      if(options.headingStyle==='setext'&&hLevel<3){
        var underline=repeat(hLevel===1?'=':'-',content.length);
        return'\n\n'+content+'\n'+underline+'\n\n';
      }else{
        return'\n\n'+repeat('#',hLevel)+' '+content+'\n\n';
      }
    }
  };

  rules.blockquote={
    filter:'blockquote',
    replacement:function(content){
      content=content.replace(/^\n+|\n+$/g,'');
      content=content.replace(/^/gm,'> ');
      return'\n\n'+content+'\n\n';
    }
  };

  rules.list={
    filter:['ul','ol'],
    replacement:function(content,node){
      var parent=node.parentNode;
      if(parent.nodeName==='LI'&&parent.lastElementChild===node){
        return'\n'+content;
      }else{
        return'\n\n'+content+'\n\n';
      }
    }
  };

  rules.listItem={
    filter:'li',
    replacement:function(content,node,options){
      content=content.replace(/^\n+/,'').replace(/\n+$/,'\n').replace(/\n/gm,'\n    ');
      var prefix=options.bulletListMarker+' ';
      var parent=node.parentNode;
      if(parent.nodeName==='OL'){
        var start=parent.getAttribute('start');
        var index=Array.prototype.indexOf.call(parent.children,node);
        prefix=(start?Number(start)+index:index+1)+'. ';
      }
      return prefix+content+(node.nextSibling&&!/\n$/.test(content)?'\n':'');
    }
  };

  rules.indentedCodeBlock={
    filter:function(node,options){
      return options.codeBlockStyle==='indented'&&
        node.nodeName==='PRE'&&
        node.firstChild&&
        node.firstChild.nodeName==='CODE';
    },
    replacement:function(content,node,options){
      return'\n\n    '+node.firstChild.textContent.replace(/\n/g,'\n    ')+'\n\n';
    }
  };

  rules.fencedCodeBlock={
    filter:function(node,options){
      return options.codeBlockStyle==='fenced'&&
        node.nodeName==='PRE'&&
        node.firstChild&&
        node.firstChild.nodeName==='CODE';
    },
    replacement:function(content,node,options){
      var className=node.firstChild.getAttribute('class')||'';
      var language=(className.match(/language-(\S+)/)||[null,''])[1];
      var code=node.firstChild.textContent;
      var fenceChar=options.fence.charAt(0);
      var fenceSize=3;
      var fenceInCodeRegex=new RegExp('^'+fenceChar+'{3,}','gm');
      var match;
      while((match=fenceInCodeRegex.exec(code))){
        if(match[0].length>=fenceSize)fenceSize=match[0].length+1;
      }
      var fence=repeat(fenceChar,fenceSize);
      return'\n\n'+fence+language+'\n'+code.replace(/\n$/,'')+'\n'+fence+'\n\n';
    }
  };

  rules.horizontalRule={
    filter:'hr',
    replacement:function(content,node,options){
      return'\n\n'+options.hr+'\n\n';
    }
  };

  rules.inlineLink={
    filter:function(node,options){
      return options.linkStyle==='inlined'&&
        node.nodeName==='A'&&
        node.getAttribute('href');
    },
    replacement:function(content,node){
      var href=node.getAttribute('href');
      var title=node.title?' "'+node.title+'"':'';
      return'['+content+']('+href+title+')';
    }
  };

  rules.referenceLink={
    filter:function(node,options){
      return options.linkStyle==='referenced'&&
        node.nodeName==='A'&&
        node.getAttribute('href');
    },
    replacement:function(content,node,options){
      var href=node.getAttribute('href');
      var title=node.title?' "'+node.title+'"':'';
      var replacement,reference;
      switch(options.linkReferenceStyle){
        case'collapsed':
          replacement='['+content+'][]';
          reference='['+content+']: '+href+title;
          break;
        case'shortcut':
          replacement='['+content+']';
          reference='['+content+']: '+href+title;
          break;
        default:
          var id=this.references.length+1;
          replacement='['+content+']['+id+']';
          reference='['+id+']: '+href+title;
      }
      this.references.push(reference);
      return replacement;
    },
    references:[],
    append:function(options){
      var references='';
      if(this.references.length){
        references='\n\n'+this.references.join('\n')+'\n\n';
        this.references=[];
      }
      return references;
    }
  };

  rules.emphasis={
    filter:['em','i'],
    replacement:function(content,node,options){
      if(!content.trim())return'';
      return options.emDelimiter+content+options.emDelimiter;
    }
  };

  rules.strong={
    filter:['strong','b'],
    replacement:function(content,node,options){
      if(!content.trim())return'';
      return options.strongDelimiter+content+options.strongDelimiter;
    }
  };

  rules.code={
    filter:function(node){
      var hasSiblings=node.previousSibling||node.nextSibling;
      var isCodeBlock=node.parentNode.nodeName==='PRE'&&!hasSiblings;
      return node.nodeName==='CODE'&&!isCodeBlock;
    },
    replacement:function(content){
      if(!content)return'';
      content=content.replace(/\r?\n|\r/g,' ');
      var extraSpace=/^`|^ .*?[^ ].* $|`$/.test(content)?' ':'';
      var delimiter='`';
      var matches=content.match(/`+/gm)||[];
      while(matches.indexOf(delimiter)!==-1)delimiter=delimiter+'`';
      return delimiter+extraSpace+content+extraSpace+delimiter;
    }
  };

  rules.image={
    filter:'img',
    replacement:function(content,node){
      var alt=node.alt||'';
      var src=node.getAttribute('src')||'';
      var title=node.title?' "'+node.title+'"':'';
      return src?'!['+alt+']('+src+title+')':'';
    }
  };

  function Rules(options){
    this.options=options;
    this._keep=[];
    this._remove=[];
    this.blankRule={replacement:options.blankReplacement};
    this.keepReplacement=options.keepReplacement;
    this.defaultRule={replacement:options.defaultReplacement};
    this.array=[];
    for(var key in options.rules)this.array.push(options.rules[key]);
  }

  Rules.prototype={
    add:function(key,rule){
      this.array.unshift(rule);
    },
    keep:function(filter){
      this._keep.unshift({filter:filter,replacement:this.keepReplacement});
    },
    remove:function(filter){
      this._remove.unshift({filter:filter,replacement:function(){return'';}});
    },
    forNode:function(node){
      if(node.isBlank)return this.blankRule;
      var rule;
      if((rule=findRule(this.array,node,this.options)))return rule;
      if((rule=findRule(this._keep,node,this.options)))return rule;
      if((rule=findRule(this._remove,node,this.options)))return rule;
      return this.defaultRule;
    },
    forEach:function(fn){
      for(var i=0;i<this.array.length;i++)fn(this.array[i],i);
    }
  };

  function findRule(rules,node,options){
    for(var i=0;i<rules.length;i++){
      var rule=rules[i];
      if(filterValue(rule,node,options))return rule;
    }
    return void 0;
  }

  function filterValue(rule,node,options){
    var filter=rule.filter;
    if(typeof filter==='string'){
      if(filter===node.nodeName.toLowerCase())return true;
    }else if(Array.isArray(filter)){
      if(filter.indexOf(node.nodeName.toLowerCase())>-1)return true;
    }else if(typeof filter==='function'){
      if(filter.call(rule,node,options))return true;
    }else{
      throw new TypeError('`filter` needs to be a string, array, or function');
    }
  }

  function collapseWhitespace(options){
    var element=options.element;
    var isBlock=options.isBlock;
    var isVoid=options.isVoid;
    var isPre=options.isPre||function(node){
      return node.nodeName==='PRE';
    };

    if(!element.firstChild||isPre(element))return;

    var prevText=null;
    var keepLeadingWs=false;
    var prev=null;
    var node=next(prev,element,isPre);

    while(node!==element){
      if(node.nodeType===3||node.nodeType===4){
        var text=node.data.replace(/[ \r\n\t]+/g,' ');
        if((!prevText||/ $/.test(prevText.data))&&
           !keepLeadingWs&&text[0]===' '){
          text=text.substr(1);
        }
        if(!text){
          node=remove(node);
          continue;
        }
        node.data=text;
        prevText=node;
      }else if(node.nodeType===1){
        if(isBlock(node)||node.nodeName==='BR'){
          if(prevText){
            prevText.data=prevText.data.replace(/ $/,'');
          }
          prevText=null;
          keepLeadingWs=false;
        }else if(isVoid(node)||isPre(node)){
          prevText=null;
          keepLeadingWs=true;
        }else{
          // empty inline element
        }
      }
      var nextNode=next(prev,node,isPre);
      prev=node;
      node=nextNode;
    }

    if(prevText){
      prevText.data=prevText.data.replace(/ $/,'');
      if(!prevText.data)remove(prevText);
    }
  }

  function next(prev,current,isPre){
    if(prev&&prev.parentNode===current||isPre(current)){
      return current.nextSibling||current.parentNode;
    }
    return current.firstChild||current.nextSibling||current.parentNode;
  }

  function remove(node){
    var next=node.nextSibling||node.parentNode;
    node.parentNode.removeChild(node);
    return next;
  }

  var escapes=[
    [/\\/g,'\\\\'],
    [/\*/g,'\\*'],
    [/^-/g,'\\-'],
    [/^\+ /g,'\\+ '],
    [/^(=+)/g,'\\$1'],
    [/^(#{1,6}) /g,'\\$1 '],
    [/`/g,'\\`'],
    [/^~~~/g,'\\~~~'],
    [/\[/g,'\\['],
    [/\]/g,'\\]'],
    [/^>/g,'\\>'],
    [/_/g,'\\_'],
    [/^(\d+)\. /g,'$1\\. ']
  ];

  function TurndownService(options){
    if(!(this instanceof TurndownService))return new TurndownService(options);
    var defaults={
      rules:rules,
      headingStyle:'setext',
      hr:'* * *',
      bulletListMarker:'*',
      codeBlockStyle:'fenced',
      fence:'```',
      emDelimiter:'_',
      strongDelimiter:'**',
      linkStyle:'inlined',
      linkReferenceStyle:'full',
      br:'  ',
      preformattedCode:false,
      blankReplacement:function(content,node){
        return node.isBlock?'\n\n':'';
      },
      keepReplacement:function(content,node){
        return node.isBlock?'\n\n'+node.outerHTML+'\n\n':node.outerHTML;
      },
      defaultReplacement:function(content,node){
        return node.isBlock?'\n\n'+content+'\n\n':content;
      }
    };
    this.options=extend({},defaults,options);
    this.rules=new Rules(this.options);
  }

  TurndownService.prototype={
    turndown:function(input){
      if(!canConvert(input)){
        throw new TypeError(input+' is not a string, or an element/document/document fragment node.');
      }
      if(input==='')return'';
      var output=process.call(this,new RootNode(input,this.options));
      return postProcess.call(this,output);
    },
    use:function(plugin){
      if(Array.isArray(plugin)){
        for(var i=0;i<plugin.length;i++)this.use(plugin[i]);
      }else if(typeof plugin==='function'){
        plugin(this);
      }else{
        throw new TypeError('plugin must be a Function or an Array of Functions');
      }
      return this;
    },
    addRule:function(key,rule){
      this.rules.add(key,rule);
      return this;
    },
    keep:function(filter){
      this.rules.keep(filter);
      return this;
    },
    remove:function(filter){
      this.rules.remove(filter);
      return this;
    },
    escape:function(string){
      return escapes.reduce(function(accumulator,escape){
        return accumulator.replace(escape[0],escape[1]);
      },string);
    }
  };

  function RootNode(input,options){
    var root;
    if(typeof input==='string'){
      var doc=new DOMParser().parseFromString(
        '<x-turndown id="turndown-root">'+input+'</x-turndown>',
        'text/html'
      );
      root=doc.getElementById('turndown-root');
    }else{
      root=input.cloneNode(true);
    }
    collapseWhitespace({
      element:root,
      isBlock:isBlock,
      isVoid:isVoid,
      isPre:options.preformattedCode?isPreOrCode:null
    });
    return root;
  }

  function isPreOrCode(node){
    return node.nodeName==='PRE'||node.nodeName==='CODE';
  }

  function canConvert(input){
    return(
      input!=null&&(
        typeof input==='string'||
        input.nodeType&&(
          input.nodeType===1||input.nodeType===9||input.nodeType===11
        )
      )
    );
  }

  function process(parentNode){
    var self=this;
    return reduce.call(parentNode.childNodes,function(output,node){
      node=new Node(node,self.options);
      var replacement='';
      if(node.nodeType===3){
        replacement=node.isCode?node.nodeValue:self.escape(node.nodeValue);
      }else if(node.nodeType===1){
        replacement=replacementForNode.call(self,node);
      }
      return join(output,replacement);
    },'');
  }

  function Node(node,options){
    node.isBlock=isBlock(node);
    node.isCode=node.nodeName==='CODE'||node.parentNode.isCode;
    node.isBlank=isBlank(node);
    node.flankingWhitespace=flankingWhitespace(node,options);
    return node;
  }

  function isBlank(node){
    return(
      !isVoid(node)&&
      !hasVoid(node)&&
      /^\s*$/i.test(node.textContent)&&
      !isBlock(node)&&
      !hasBlock(node)
    );
  }

  function hasBlock(node){
    for(var i=0;i<node.childNodes.length;i++){
      if(isBlock(node.childNodes[i]))return true;
    }
    return false;
  }

  function flankingWhitespace(node,options){
    if(node.isBlock||(options.preformattedCode&&node.isCode)){
      return{leading:'',trailing:''};
    }
    var edges=edgeWhitespace(node.textContent);
    if(edges.leadingAscii&&isFlankedByWhitespace('left',node,options)){
      edges.leading=edges.leadingNonAscii;
    }
    if(edges.trailingAscii&&isFlankedByWhitespace('right',node,options)){
      edges.trailing=edges.trailingNonAscii;
    }
    return{leading:edges.leading,trailing:edges.trailing};
  }

  function edgeWhitespace(string){
    var m=string.match(/^(([ \t\r\n]*)(\s*))(?:(?=\S)[\s\S]*\S)?((\s*)([ \t\r\n]*))$/);
    return{
      leading:m[1],
      leadingAscii:m[2],
      leadingNonAscii:m[3],
      trailing:m[4],
      trailingNonAscii:m[5],
      trailingAscii:m[6]
    };
  }

  function isFlankedByWhitespace(side,node,options){
    var sibling,regExp,isFlanked;
    if(side==='left'){
      sibling=node.previousSibling;
      regExp=/\s$/;
    }else{
      sibling=node.nextSibling;
      regExp=/^\s/;
    }
    if(sibling){
      if(sibling.nodeType===3){
        isFlanked=regExp.test(sibling.nodeValue);
      }else if(options.preformattedCode&&sibling.nodeName==='CODE'){
        isFlanked=false;
      }else if(sibling.nodeType===1&&!isBlock(sibling)){
        isFlanked=regExp.test(sibling.textContent);
      }
    }
    return isFlanked;
  }

  function replacementForNode(node){
    var rule=this.rules.forNode(node);
    var content=process.call(this,node);
    var whitespace=node.flankingWhitespace;
    if(whitespace.leading||whitespace.trailing){
      content=content.trim();
    }
    return(
      whitespace.leading+
      rule.replacement(content,node,this.options)+
      whitespace.trailing
    );
  }

  function join(output,replacement){
    var s1=trimTrailingNewlines(output);
    var s2=trimLeadingNewlines(replacement);
    var nls=Math.max(output.length-s1.length,replacement.length-s2.length);
    var separator='\n\n'.substring(0,nls);
    return s1+separator+s2;
  }

  function postProcess(output){
    var self=this;
    this.rules.forEach(function(rule){
      if(typeof rule.append==='function'){
        output=join(output,rule.append(self.options));
      }
    });
    return output.replace(/^[\t\r\n]+/,'').replace(/[\t\r\n\s]+$/,'');
  }

  function reduce(callback,initialValue){
    var acc=initialValue;
    for(var i=0;i<this.length;i++){
      acc=callback(acc,this[i],i);
    }
    return acc;
  }

  if(typeof module!=='undefined'&&module.exports){
    module.exports=TurndownService;
  }else{
    global.TurndownService=TurndownService;
  }
})(typeof window!=='undefined'?window:this);
