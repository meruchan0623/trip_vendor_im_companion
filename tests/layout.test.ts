import{describe,it,expect}from'vitest';
import{pinnedBounds,attachedVisible,browserBounds,browserContentBounds,identifierOverlayBounds,composerPreviewBounds}from'../electron/layout';
import{placeLocalWindow,stableConvertedBounds,type LocalWindow}from'../electron/window-placement';
import{vi}from'vitest';
describe('DIP panel attachment geometry',()=>{
  const work={x:0,y:0,width:1920,height:1040};
  it('attaches flush to the right edge and matches target height',()=>expect(pinnedBounds({x:100,y:100,width:1000,height:800},work,480)).toEqual({layout:'right',bounds:{x:1100,y:100,width:480,height:800}}));
  it('uses the left edge when the right side has no room',()=>expect(pinnedBounds({x:700,y:100,width:1100,height:800},work,480)).toEqual({layout:'left',bounds:{x:220,y:100,width:480,height:800}}));
  it('uses an explicit overlay without moving a maximized target',()=>expect(pinnedBounds({...work},work,480)).toEqual({layout:'overlay',bounds:{x:1440,y:0,width:480,height:1040}}));
  it('recalculates bounds for a wide query view inside the work area',()=>expect(pinnedBounds({x:100,y:100,width:1000,height:800},work,1100)).toEqual({layout:'overlay',bounds:{x:0,y:100,width:1100,height:800}}));
  it('respects negative monitor coordinates and a short target',()=>expect(pinnedBounds({x:-1600,y:10,width:900,height:400},{x:-1920,y:0,width:1920,height:1080},480)).toEqual({layout:'right',bounds:{x:-700,y:10,width:480,height:400}}));
});
describe('normalized native overlay placement',()=>{
  it('raises a newly shown topmost overlay after showing without activating it',()=>{
    let visible=false;
    const calls:string[]=[];
    const window:LocalWindow={getBounds:()=>({x:0,y:0,width:500,height:40}),setBounds:vi.fn(),isVisible:()=>visible,showInactive:vi.fn(()=>{calls.push('showInactive');visible=true;}),hide:vi.fn(),isAlwaysOnTop:()=>true,setAlwaysOnTop:vi.fn(),setSkipTaskbar:vi.fn(),moveTop:vi.fn(()=>calls.push('moveTop')),webContents:{invalidate:()=>{calls.push('invalidate');}}};
    placeLocalWindow(window,{visible:true,topmost:true});
    expect(calls).toEqual(['showInactive','invalidate','moveTop']);
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
  });
  it('raises a visible topmost overlay only for explicit restacking, not polling or movement',()=>{
    let actual={x:0,y:0,width:500,height:40},visible=true;
    const window:LocalWindow={getBounds:()=>actual,setBounds:vi.fn(bounds=>{actual=bounds;}),setPosition:vi.fn((x,y)=>{actual={...actual,x,y};}),isVisible:()=>visible,showInactive:vi.fn(),hide:vi.fn(()=>{visible=false;}),isAlwaysOnTop:()=>true,setAlwaysOnTop:vi.fn(),setSkipTaskbar:vi.fn(),moveTop:vi.fn()};
    placeLocalWindow(window,{visible:true,topmost:true,restack:true});
    expect(window.moveTop).toHaveBeenCalledTimes(1);
    expect(window.showInactive).not.toHaveBeenCalled();
    vi.mocked(window.moveTop!).mockClear();
    for(let index=0;index<10;index++)placeLocalWindow(window,{visible:true,topmost:true,bounds:{...actual,x:index}});
    expect(window.setPosition).toHaveBeenCalledTimes(9);
    expect(window.moveTop).not.toHaveBeenCalled();
    placeLocalWindow(window,{visible:false,topmost:true,restack:true});
    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(window.moveTop).not.toHaveBeenCalled();
    placeLocalWindow(window,{visible:true,topmost:false,restack:true});
    expect(window.moveTop).not.toHaveBeenCalled();
  });
  it('retains converted extents through rounding phases and invalidates source or context changes',()=>{
    const key={},source={x:0,y:0,width:1029,height:57};
    expect(stableConvertedBounds(key,source,{x:0,y:0,width:686,height:38},'target1:144:display1:1.5')).toEqual({x:0,y:0,width:686,height:38});
    expect(stableConvertedBounds(key,{...source,x:1,y:1},{x:1,y:1,width:687,height:39},'target1:144:display1:1.5')).toEqual({x:1,y:1,width:686,height:38});
    expect(stableConvertedBounds(key,{...source,width:1032},{x:1,y:1,width:688,height:39},'target1:144:display1:1.5').width).toBe(688);
    expect(stableConvertedBounds(key,source,{x:1,y:1,width:687,height:39},'target1:144:display1:1.5').width).toBe(687);
    expect(stableConvertedBounds(key,{...source,height:60},{x:1,y:1,width:687,height:40},'target1:144:display1:1.5').height).toBe(40);
    expect(stableConvertedBounds(key,source,{x:1,y:1,width:686,height:38},'target1:144:display1:1.5').height).toBe(38);
    expect(stableConvertedBounds(key,source,{x:2,y:2,width:515,height:29},'target1:144:display1:2').width).toBe(515);
    expect(stableConvertedBounds(key,source,{x:2,y:2,width:515,height:29},'target1:192:display1:2').width).toBe(515);
    expect(stableConvertedBounds(key,source,{x:3,y:3,width:516,height:30},'target1:192:display2:2').width).toBe(516);
    expect(stableConvertedBounds(key,source,{x:4,y:4,width:517,height:31},'target2:192:display2:2').width).toBe(517);
    expect(stableConvertedBounds({},source,{x:4,y:4,width:686,height:38},'target2:192:display2:2').width).toBe(686);
  });
  it('moves without resizing when accepted native extents change asynchronously',()=>{
    let actual={x:0,y:0,width:687,height:39};
    const window:LocalWindow={getBounds:()=>actual,setBounds:vi.fn(bounds=>{actual=bounds;}),setPosition:vi.fn((x,y)=>{actual={...actual,x,y};}),isVisible:()=>true,showInactive:vi.fn(),hide:vi.fn(),isAlwaysOnTop:()=>true,setAlwaysOnTop:vi.fn(),setSkipTaskbar:vi.fn()};
    const requested={...actual};
    placeLocalWindow(window,{visible:true,topmost:true,bounds:requested});
    for(let index=1;index<=4;index++){
      actual={...actual,width:688+index%2,height:38+index%4};
      placeLocalWindow(window,{visible:true,topmost:true,bounds:{...requested,x:index,y:index}});
    }
    expect(window.setBounds).not.toHaveBeenCalled();
    expect(window.setPosition).toHaveBeenCalledTimes(4);
    actual={...actual,x:99,y:99};
    placeLocalWindow(window,{visible:true,topmost:true,bounds:{...requested,x:4,y:4}});
    expect(window.setPosition).toHaveBeenLastCalledWith(4,4);
    placeLocalWindow(window,{visible:true,topmost:true,bounds:{...requested,width:700}});
    expect(window.setBounds).toHaveBeenCalledExactlyOnceWith({...requested,width:700});
  });
  it('repairs large external resizes and cumulative drift against a fixed normalization baseline',()=>{
    let actual={x:0,y:0,width:687,height:39};
    const window:LocalWindow={getBounds:()=>actual,setBounds:vi.fn(bounds=>{actual={...bounds};}),setPosition:vi.fn((x,y)=>{actual={...actual,x,y};}),isVisible:()=>true,showInactive:vi.fn(),hide:vi.fn(),isAlwaysOnTop:()=>true,setAlwaysOnTop:vi.fn(),setSkipTaskbar:vi.fn()};
    const requested={...actual};
    placeLocalWindow(window,{visible:true,topmost:true,bounds:requested});
    for(let index=1;index<=2;index++){
      actual={...actual,width:actual.width+1};
      placeLocalWindow(window,{visible:true,topmost:true,bounds:{...requested,x:index}});
    }
    expect(window.setBounds).not.toHaveBeenCalled();
    actual={...actual,width:actual.width+1};
    placeLocalWindow(window,{visible:true,topmost:true,bounds:{...requested,x:3}});
    expect(window.setBounds).toHaveBeenCalledExactlyOnceWith({...requested,x:3});
    actual={...actual,width:900,height:200};
    placeLocalWindow(window,{visible:true,topmost:true,bounds:{...requested,x:4}});
    expect(window.setBounds).toHaveBeenLastCalledWith({...requested,x:4});
    expect(window.setBounds).toHaveBeenCalledTimes(2);
  });
  it('accepts normalized coordinates during bounded size jitter but repairs external movement',()=>{
    let actual={x:0,y:0,width:500,height:40};
    const window:LocalWindow={getBounds:()=>actual,setBounds:vi.fn(bounds=>{actual={...bounds,x:bounds.x+1,y:bounds.y+1};}),setPosition:vi.fn((x,y)=>{actual={...actual,x:x+1,y:y+1};}),isVisible:()=>true,showInactive:vi.fn(),hide:vi.fn(),isAlwaysOnTop:()=>true,setAlwaysOnTop:vi.fn(),setSkipTaskbar:vi.fn()};
    const bounds={x:100,y:100,width:500,height:40};
    placeLocalWindow(window,{visible:true,topmost:true,bounds});
    expect(actual).toEqual({...bounds,x:101,y:101});
    vi.mocked(window.setPosition!).mockClear();
    for(let index=0;index<6;index++){
      actual={...actual,width:500+(index%2?1:-1),height:40+(index%2?-1:1)};
      placeLocalWindow(window,{visible:true,topmost:true,bounds});
    }
    expect(window.setPosition).not.toHaveBeenCalled();expect(window.setBounds).not.toHaveBeenCalled();
    actual={...actual,x:150,y:150};
    placeLocalWindow(window,{visible:true,topmost:true,bounds});
    expect(window.setPosition).toHaveBeenCalledExactlyOnceWith(100,100);
    actual={...actual,width:503};
    placeLocalWindow(window,{visible:true,topmost:true,bounds});
    expect(window.setBounds).toHaveBeenCalledExactlyOnceWith(bounds);
  });
  it('accepts the Windows minimum height and moves without repeatedly resizing',()=>{
    let actual={x:0,y:0,width:500,height:42};
    const window:LocalWindow={getBounds:()=>actual,setBounds:vi.fn(bounds=>{actual={...bounds,height:Math.max(42,bounds.height)};}),setPosition:vi.fn((x,y)=>{actual={...actual,x,y};}),isVisible:()=>true,showInactive:vi.fn(),hide:vi.fn(),isAlwaysOnTop:()=>true,setAlwaysOnTop:vi.fn(),setSkipTaskbar:vi.fn()};
    const bounds={x:100,y:100,width:500,height:40};
    for(let index=0;index<60;index++)placeLocalWindow(window,{visible:true,topmost:true,bounds});
    expect(window.setBounds).toHaveBeenCalledTimes(1);
    for(let index=1;index<=60;index++)placeLocalWindow(window,{visible:true,topmost:true,bounds:{...bounds,x:100+index}});
    expect(window.setBounds).toHaveBeenCalledTimes(1);
    expect(window.setPosition).toHaveBeenCalledTimes(60);
    expect(actual).toEqual({x:160,y:100,width:500,height:42});
    placeLocalWindow(window,{visible:true,topmost:true,bounds:{...bounds,width:600,height:48}});
    expect(window.setBounds).toHaveBeenCalledTimes(2);
    expect(actual).toEqual({x:100,y:100,width:600,height:48});
  });
  it('repairs an externally changed position instead of trusting a stale cache',()=>{
    let actual={x:0,y:0,width:500,height:40};
    const window:LocalWindow={getBounds:()=>actual,setBounds:vi.fn(bounds=>{actual=bounds;}),setPosition:vi.fn((x,y)=>{actual={...actual,x,y};}),isVisible:()=>false,showInactive:vi.fn(),hide:vi.fn(),isAlwaysOnTop:()=>false,setAlwaysOnTop:vi.fn(),setSkipTaskbar:vi.fn()};
    const bounds={x:100,y:100,width:500,height:40};
    placeLocalWindow(window,{visible:false,bounds});actual={...actual,x:200};placeLocalWindow(window,{visible:false,bounds});
    expect(window.setPosition).toHaveBeenCalledTimes(2);expect(actual).toEqual(bounds);
  });
});
describe('external overlay geometry and visibility',()=>{
  it('requires target visibility and approved foreground group',()=>{
    expect(attachedVisible({visible:true,minimized:false,foreground:false,groupForeground:true})).toBe(true);
    expect(attachedVisible({visible:true,minimized:false,foreground:false,groupForeground:false})).toBe(false);
    expect(attachedVisible({visible:true,minimized:true,foreground:true,groupForeground:true})).toBe(false);
  });
  it('keeps a browser within a negative-coordinate monitor',()=>{
    const bounds=browserBounds({x:-1800,y:100,width:1200,height:900},{x:-1920,y:0,width:1920,height:1080},800)!;
    expect(bounds.x).toBeGreaterThanOrEqual(-1920);expect(bounds.x+bounds.width).toBeLessThanOrEqual(0);expect(bounds.y+bounds.height).toBeLessThanOrEqual(1080);
  });
  it('reserves the local action bar without overlapping the measured reply toolbar',()=>{
    const frame=browserBounds({x:100,y:100,width:1000,height:800},{x:0,y:0,width:1920,height:1040},700)!;
    const content=browserContentBounds(frame);
    expect(frame).toEqual({x:120,y:148,width:960,height:544});
    expect(content).toEqual({x:120,y:192,width:960,height:500});
    expect(content.y+content.height).toBeLessThan(700);
  });
  it('fits a low viewport only while a usable result and reply area both fit',()=>{
    const target={x:0,y:0,width:1024,height:640},display={x:0,y:0,width:1024,height:720};
    expect(browserBounds(target,display,400)).toEqual({x:32,y:48,width:960,height:344});
    expect(browserBounds(target,display,300)).toBeNull();
    expect(browserBounds({...target,width:480},display,400)).toBeNull();
    expect(browserBounds(target,display)).toBeNull();
    expect(browserBounds(target,display,NaN)).toBeNull();
  });
  it('maps CSS order rect to physical client pixels including header and 150% DPI',()=>{
    expect(identifierOverlayBounds({x:-1500,y:50,width:1500,height:1000},{width:1000,height:600,dpr:1.5},{x:100,y:200,width:120,height:20})).toEqual({x:-1350,y:450,width:180,height:30});
  });
  it('maps the real BrowserView offset instead of rejecting its narrower viewport',()=>{
    expect(identifierOverlayBounds({x:0,y:0,width:1920,height:1440},{width:1212,height:920,dpr:1.5,clientOffset:{x:102,y:60}},{x:300,y:740,width:584,height:40})).toEqual({x:552,y:1170,width:876,height:60});
    expect(identifierOverlayBounds({x:0,y:0,width:1920,height:1440},{width:1212,height:920,dpr:1.5,clientOffset:{x:0,y:60}},{x:300,y:740,width:584,height:40})).toBeNull();
  });
  it('declines detached viewports and partially offscreen order text',()=>{
    const client={x:0,y:0,width:1000,height:800},viewport={width:1000,height:700,dpr:1};
    expect(identifierOverlayBounds(client,{...viewport,width:500},{x:1,y:1,width:100,height:20})).toBeNull();
    expect(identifierOverlayBounds(client,viewport,{x:950,y:1,width:100,height:20})).toBeNull();
    expect(identifierOverlayBounds(client,viewport,{x:1,y:-5,width:100,height:20})).toBeNull();
  });
});

describe('outbound preview expansion',()=>{
 const viewport={width:1000,height:700},reply={x:200,y:400,width:600,height:250},toolbar={x:300,y:400,width:500,height:40};
 it('grows upward 190px with its bottom toolbar exactly anchored',()=>{const result=composerPreviewBounds(toolbar,reply,viewport,true)!;expect(result).toEqual({x:300,y:210,width:500,height:230});expect(result.y+result.height).toBe(toolbar.y+toolbar.height);});
 it('keeps 200px narrow ranges usable and never grows into the editor below toolbar',()=>{const result=composerPreviewBounds({...toolbar,width:200},reply,viewport,true)!;expect(result.width).toBe(200);expect(result.y+result.height).toBe(440);});
 it('supports reply-container padding before toolbar and collapses with no room above',()=>{expect(composerPreviewBounds({...toolbar,y:416},reply,viewport,true)?.height).toBe(230);expect(composerPreviewBounds({...toolbar,y:90},{...reply,y:90},viewport,true)?.height).toBe(44);expect(composerPreviewBounds(toolbar,reply,viewport,false)).toEqual({...toolbar,y:396,height:44});});
 it('rejects offscreen, nonfinite, or unverified ranges instead of moving across native controls',()=>{expect(composerPreviewBounds({...toolbar,x:-1},reply,viewport,true)).toBeNull();expect(composerPreviewBounds({...toolbar,y:680},reply,viewport,true)).toBeNull();expect(composerPreviewBounds({...toolbar,width:NaN},reply,viewport,true)).toBeNull();expect(composerPreviewBounds({...toolbar,height:60},reply,viewport,true)).toBeNull();});
 it('maps the complete expansion at 150% DPI without changing toolbar alignment',()=>{const range=composerPreviewBounds(toolbar,reply,viewport,true)!;const result=identifierOverlayBounds({x:-1200,y:100,width:1500,height:1050},{...viewport,dpr:1.5},range)!;expect(result).toEqual({x:-750,y:415,width:750,height:345});expect(result.y+result.height).toBe(100+(toolbar.y+toolbar.height)*1.5);});
});
