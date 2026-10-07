/* N2K live database connector — TEST MODE
   Real Supabase project; anon key constrained by test_ RLS policies (file 14).
   Every helper throws on failure so pages fall back to their built-in demo data. */
/* Today's date as the USER sees it, "YYYY-MM-DD".
   new Date().toISOString() gives the UTC date, which in India is the previous
   day for the whole working morning — and for a date built from local midnight
   it is the previous day ALL day. Every date-only "today" must use this.
   Declared at file scope: this file is a series of separate closures, so a
   const inside one of them is invisible to the others. */
function n2kTodayLocal(){
  const n=new Date();
  return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+
         '-'+String(n.getDate()).padStart(2,'0');
}

window.N2K = (function () {
  const URL = 'https://smtzdqflciqqsdktozmf.supabase.co';
  const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtdHpkcWZsY2lxcXNka3Rvem1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2OTQxMTEsImV4cCI6MjEwMDI3MDExMX0.rMB6NA_a9vKsSK9Blm7xFTrmz0E57jByg5JV99MXFiA';
  const sb = window.supabase ? window.supabase.createClient(URL, KEY) : null;
  const need = () => { if (!sb) throw new Error('supabase-js not loaded'); };
  const ok = r => { if (r.error) throw r.error; return r.data; };

  /* The cache holds the PROMISE, not just the finished result.

     It used to fill only after the query returned, so several sections starting
     at the same moment each saw it empty and each fired their own identical
     query. Three round trips for one list, and every section waited its own —
     which is why a page appeared piece by piece instead of all at once.
     Caching the promise means the first caller queries and the rest wait on
     that same request. */
  let _fac = null, _facPromise = null;
  async function facilities() {
    need();
    if (_fac) return _fac;
    if (_facPromise) return _facPromise;
    _facPromise = (async () => {
      const d = ok(await sb.from('facilities')
        .select('id,code,name,kind,city,is_active').eq('is_active', true).order('name'));
      _fac = { list: d, byCode: Object.fromEntries(d.map(f => [f.code, f])),
               byId: Object.fromEntries(d.map(f => [f.id, f])) };
      _facPromise = null;
      return _fac;
    })();
    return _facPromise;
  }
  async function articles() {
    need();
    return ok(await sb.from('articles').select('id,name').eq('is_active', true).order('name'));
  }
  // staff lookup: {staff:{...}} if registered, {customer:true} if not
  async function findStaff(phone) {
    need();
    const d = ok(await sb.from('users')
      .select('full_name,role,is_active,phone,must_change_password,facility:facility_id(code,name)').eq('phone', phone).limit(1));
    if (!d.length) return { customer: true };
    const u = d[0];
    const map = {
      booking_agent: { dest: 'n2k_agent_booking.html', lbl: 'Cargo booking', role: 'Booking branch' },
      admin:         { dest: 'n2k_dispatch.html',      lbl: 'Dashboard',                role: 'Admin' },
      driver:        { dest: 'n2k_driver.html',        lbl: 'Driver app — today\u2019s stops', role: 'Driver' }
    };
    const m = map[u.role] || map.admin;
    return { staff: { name: u.full_name, active: u.is_active, dest: m.dest, lbl: m.lbl,
                      role: m.role, roleKey: u.role, mustSet: !!u.must_change_password,
                      branch: u.facility && u.facility.code || null,
                      branchName: u.facility && u.facility.name || null } };
  }
  async function addrFor(phone) {
    need();
    const d = ok(await sb.from('customer_addresses')
      .select('label,door_street,city,landmark,pincode,is_default').eq('phone', phone));
    return d.map(a => ({ label: a.label || 'Saved', door: a.door_street, city: a.city || '',
                         land: a.landmark || '', pin: a.pincode || '', def: a.is_default }));
  }
  async function ensureCustomer(name, phone, gstin, kind) {
    const d = ok(await sb.from('customers').select('id').eq('contact_phone', phone).limit(1));
    if (d.length) return d[0].id;
    const ins = ok(await sb.from('customers')
      .insert({ name: name, contact_phone: phone, gstin: gstin || null, kind: kind || 'individual' })
      .select('id'));
    return ins[0].id;
  }
  /* p = {manualLr, senderName, senderPhone, senderGstin, senderKind,
          destCode, receiverName, receiverPhone, receiverGstin, receiverKind,
          address, city, landmark, pincode, pickup:{addr,city,land,pin},
          scope, dtype, pay, mode, eway, lines:[{article,desc,qty,uom,awt,bwt,rate}],
          loading, docket, freight, grand, pieces, weight} */
  async function saveBooking(p) {
    need();
    const F = await facilities();
    const origin = F.byCode[p.originCode], dest = F.byCode[p.destCode];
    if (!origin || !dest) throw new Error('facility lookup failed');
    const lr = p.manualLr ? p.manualLr :
      ok(await sb.rpc('next_lr', { p_branch: p.originCode }));
    const customerId = await ensureCustomer(p.senderName, p.senderPhone, p.senderGstin, p.senderKind);
    const booking = ok(await sb.from('bookings').insert({
      booking_number: lr, channel: 'offline',
      customer_id: customerId, origin_facility_id: origin.id,
      receiver_name: p.receiverName, receiver_phone: p.receiverPhone,
      receiver_address: (p.address ? p.address + ', ' : '') + (p.city || dest.name),
      receiver_city: p.city || null, receiver_landmark: p.landmark || null,
      receiver_pincode: p.pincode || null,
      receiver_gstin: p.receiverGstin || null, receiver_kind: p.receiverKind,
      destination_facility_id: dest.id,
      payment_type: p.pay, transaction_mode: p.mode || null,
      scope: p.scope, lr_mode: p.manualLr ? 'manual' : 'system',
      manual_lr_number: p.manualLr || null,
      delivery_type: p.dtype, eway_bill_number: p.eway || null,
      pickup_address: p.pickup.addr || null, pickup_city: p.pickup.city || null,
      pickup_landmark: p.pickup.land || null, pickup_pincode: p.pickup.pin || null,
      total_pieces: p.pieces, total_weight_kg: p.weight || null,
      freight_total: p.freight, total_loading_charges: p.loading,
      docket_charges: p.docket, grand_total: p.grand, status: 'booked'
    }).select('id'))[0];
    const arts = await articles().catch(() => []);
    const byName = Object.fromEntries(arts.map(a => [a.name, a.id]));
    if (p.lines.length) ok(await sb.from('booking_lines').insert(p.lines.map(l => ({
      booking_id: booking.id, article_id: byName[l.article] || null,
      description: l.desc || l.article, quantity: l.qty, uom: l.uom || 'fixed',
      actual_weight_kg: l.awt || null, billable_weight: l.bwt,
      freight_per_qty: l.rate, loading_per_uom: 0
    }))));
    const items = ok(await sb.from('consignment_items').insert(
      Array.from({ length: p.pieces }, (_, i) => ({
        booking_id: booking.id, waybill_number: lr + '-' + (i + 1),
        sequence: i + 1, current_status: 'booked', current_facility_id: origin.id
      }))).select('id'));
    await sb.from('scan_events').insert(items.map(it => ({
      item_id: it.id, booking_id: booking.id, scan_type: 'booked',
      facility_id: origin.id, note: 'Booked at counter (test)'
    })));
    return { lr, id: booking.id };
  }
  async function trackLR(lr) {
    need();
    const d = ok(await sb.from('bookings').select(
      'id,booking_number,status,total_pieces,receiver_name,grand_total,payment_type,created_at,' +
      'origin:origin_facility_id(name,code),dest:destination_facility_id(name,code),' +
      'consignment_items(waybill_number,sequence,current_status)')
      .eq('booking_number', lr).limit(1));
    return d.length ? d[0] : null;
  }
  async function recentBookings(n) {
    need();
    return ok(await sb.from('bookings').select(
      'id,booking_number,receiver_name,total_pieces,channel,status,created_at,grand_total,' +
      'payment_type,transaction_mode,cancelled_at,cancel_reason,' +
      'origin:origin_facility_id(code),dest:destination_facility_id(code)')
      .order('created_at', { ascending: false }).limit(n || 8));
  }
  async function openStops(n) {
    need();
    return ok(await sb.from('bookings').select(
      'id,booking_number,receiver_name,receiver_address,total_pieces,payment_type,grand_total,status')
      .neq('status', 'delivered').is('cancelled_at', null)
      .order('created_at', { ascending: false }).limit(n || 8));
  }
  async function markDelivered(bookingId) {
    need();
    const items = ok(await sb.from('consignment_items').select('id').eq('booking_id', bookingId));
    await sb.from('consignment_items').update({
      current_status: 'delivered', delivered_at: new Date().toISOString()
    }).eq('booking_id', bookingId);
    await sb.from('bookings').update({ status: 'delivered' }).eq('id', bookingId);
    if (items.length) await sb.from('scan_events').insert(items.map(it => ({
      item_id: it.id, booking_id: bookingId, scan_type: 'delivered',
      note: 'Delivered — driver app (test)'
    })));
  }
  async function todayStats(originCode) {
    need();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let q = sb.from('bookings')
      .select('grand_total,status,origin:origin_facility_id(code)')
      .is('cancelled_at', null)
      .gte('created_at', today.toISOString());
    const d = ok(await q);
    const rows = originCode ? d.filter(r => r.origin && r.origin.code === originCode) : d;
    return {
      count: rows.length,
      revenue: rows.reduce((a, r) => a + (parseFloat(r.grand_total) || 0), 0),
      delivered: rows.filter(r => r.status === 'delivered').length
    };
  }
  return { sb, facilities, articles, findStaff, addrFor, saveBooking,
           trackLR, recentBookings, openStops, markDelivered, todayStats,
           // needed to reach the doc-access Edge Function; both are already
           // public values (the anon key ships in this file by design)
           SUPABASE_URL: URL, SUPABASE_ANON_KEY: KEY };
})();

/* ---- LIVE-MODE additions ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  N.session={
    save(u){try{sessionStorage.setItem('n2k_user',JSON.stringify(u));}catch(e){}},
    get(){try{return JSON.parse(sessionStorage.getItem('n2k_user'));}catch(e){return null;}},
    clear(){try{sessionStorage.removeItem('n2k_user');}catch(e){}}
  };
  N.requireRole=function(roles){
    const u=N.session.get();
    if(!u||!roles.includes(u.role)){location.replace('./');return null;}
    N.revalidate(u,roles);   // re-checked against the database on every page
    return u;
  };
  // Server-side re-check on every page load: catches disabled staff (resignation),
  // role changes and deleted accounts even if the browser session is still open.
  N.revalidate=async function(u,roles){
    try{
      const r=await N.findStaff(u.phone);
      if(!r.staff){ N.kick('removed'); return; }
      const s=r.staff;
      if(!s.active){ N.kick('disabled'); return; }
      if(s.roleKey!==u.role){
        N.session.save({name:s.name,phone:u.phone,role:s.roleKey,
          branch:s.branch,branchName:s.branchName});
        if(!roles.includes(s.roleKey)) location.replace(s.dest||'n2k_signin.html');
        return;
      }
      if((s.branch||null)!==(u.branch||null)){
        N.session.save({name:s.name,phone:u.phone,role:s.roleKey,
          branch:s.branch,branchName:s.branchName});
        location.reload();
      }
    }catch(e){ /* offline: leave the session alone, pages already show errors */ }
  };
  N.kick=function(reason){
    N.session.clear();
    location.replace('./?access='+reason);
  };
  N.signOut=function(){N.session.clear();location.href='./';};
  N.myBookings=async function(phone){
    const cust=ok(await sb.from('customers').select('id').eq('contact_phone',phone));
    let q=sb.from('bookings').select(
      'booking_number,status,total_pieces,created_at,'+
      'origin:origin_facility_id(name),dest:destination_facility_id(name)')
      .order('created_at',{ascending:false}).limit(20);
    q = cust.length
      ? q.or('customer_id.in.('+cust.map(c=>c.id).join(',')+'),receiver_phone.eq.'+phone)
      : q.eq('receiver_phone',phone);
    return ok(await q);
  };
  N.findPrebooking=async function(qs){
    const sel='id,booking_number,prebooking_code,receiver_name,receiver_phone,receiver_address,receiver_city,'+
      'total_pieces,dest:destination_facility_id(code,name),customer:customer_id(full_name,phone)';
    let d=ok(await sb.from('bookings').select(sel).eq('prebooking_code',qs.toUpperCase()).limit(1));
    if(!d.length && /^\d{10}$/.test(qs))
      d=ok(await sb.from('bookings').select(sel).eq('channel','online').is('destination_facility_id',null)
            .eq('receiver_phone',qs).order('created_at',{ascending:false}).limit(1));
    return d.length?d[0]:null;
  };
  N.todayByBranch=async function(){
    const t=new Date();t.setHours(0,0,0,0);
    const d=ok(await sb.from('bookings')
      .select('grand_total,status,origin:origin_facility_id(code,name)')
      .is('cancelled_at',null)
      .gte('created_at',t.toISOString()));
    const m={};
    d.forEach(r=>{const k=r.origin?r.origin.code:'—';
      m[k]=m[k]||{name:r.origin?r.origin.name:'—',count:0,revenue:0,delivered:0};
      m[k].count++;m[k].revenue+=parseFloat(r.grand_total)||0;
      if(r.status==='delivered')m[k].delivered++;});
    return m;
  };
  N.todayBookingsFor=async function(code,n){
    const t=new Date();t.setHours(0,0,0,0);
    const F=await N.facilities();const f=F.byCode[code];if(!f)return[];
    return ok(await sb.from('bookings').select(
      'booking_number,receiver_name,total_pieces,payment_type,grand_total,status,'+
      'dest:destination_facility_id(code)')
      .eq('origin_facility_id',f.id).is('cancelled_at',null)
      .gte('created_at',t.toISOString())
      .order('created_at',{ascending:false}).limit(n||25));
  };
  N.submitDayClose=async function(code,cash,expenses){
    const F=await N.facilities();const f=F.byCode[code];if(!f)throw new Error('branch not found');
    const u=N.session.get();
    let by=null;
    if(u&&u.phone){const ur=ok(await sb.from('users').select('id').eq('phone',u.phone).limit(1));
      if(ur.length)by=ur[0].id;}
    const dc=ok(await sb.from('branch_day_close').upsert({
      facility_id:f.id,close_date:n2kTodayLocal(),
      status:'submitted',submitted_at:new Date().toISOString(),submitted_by:by,
      opening_balance:cash.opening||0,cash_received:cash.received||0,
      amt_from_ho:cash.ho||0,cash_on_hand:cash.onhand||0,notes:cash.notes||null
    },{onConflict:'facility_id,close_date'}).select('id'))[0];
    await sb.from('day_expenses').delete().eq('day_close_id',dc.id);
    if(expenses.length)ok(await sb.from('day_expenses').insert(
      expenses.map(e=>({day_close_id:dc.id,category:e.category,description:e.description||null,amount:e.amount}))));
    return dc.id;
  };
  // patch saveBooking to accept channel/prebooking/origin/bookedBy
  const _save=N.saveBooking;
  N.saveBooking=async function(p){
    p.pickup=p.pickup||{};p.lines=p.lines||[];
    const F=await N.facilities();
    if(!p.originCode) throw new Error('No booking branch set for this user — ask admin to set it in Masters');
    const origin=F.byCode[p.originCode];
    const dest=p.destCode?F.byCode[p.destCode]:null;
    if(!origin)throw new Error('origin branch not found');
    const lr=p.manualLr?p.manualLr:ok(await sb.rpc('next_lr',{p_branch:p.originCode}));
    const customerId=await (async()=>{
      const d=ok(await sb.from('customers').select('id,gstin,name').eq('contact_phone',p.senderPhone).limit(1));
      if(d.length){
        /* An existing customer: fold back anything the agent typed that the
           master does not yet know. Without this a GSTIN entered at the counter
           is used on that one LR and then lost, and the same customer is asked
           for it again on their next booking. A blank never overwrites. */
        const patch={};
        if(p.senderGstin && !d[0].gstin) patch.gstin=p.senderGstin;
        if(p.senderName && p.senderName!==d[0].name) patch.name=p.senderName;
        if(Object.keys(patch).length){
          try{ await sb.from('customers').update(patch).eq('id',d[0].id); }catch(e){}
        }
        return d[0].id;
      }
      // walk-in customer: created automatically on their first booking
      return ok(await sb.from('customers').insert({name:p.senderName,contact_phone:p.senderPhone,
        gstin:p.senderGstin||null,kind:p.senderKind||'individual'}).select('id'))[0].id;})();
    let by=null;
    if(p.bookedByPhone){const ur=ok(await sb.from('users').select('id').eq('phone',p.bookedByPhone).limit(1));
      if(ur.length)by=ur[0].id;}
    const booking=ok(await sb.from('bookings').insert({
      booking_number:lr,channel:p.channel||'offline',customer_id:customerId,
      origin_facility_id:origin.id,booked_by:by,
      receiver_name:p.receiverName,receiver_phone:p.receiverPhone,
      receiver_address:(p.address?p.address+', ':'')+(p.city||(dest?dest.name:'')||'—'),
      receiver_city:p.city||null,receiver_landmark:p.landmark||null,receiver_pincode:p.pincode||null,
      receiver_gstin:p.receiverGstin||null,receiver_kind:p.receiverKind||'individual',
      destination_facility_id:dest?dest.id:null,
      payment_type:p.pay,transaction_mode:p.mode||null,
      scope:p.scope||'outstation',lr_mode:p.manualLr?'manual':'system',
      manual_lr_number:p.manualLr||null,delivery_type:p.dtype||null,
      eway_bill_number:p.eway||null,prebooking_code:p.prebooking||null,
      freight_basis:p.freightBasis||'weight',
      drop_point_id:p.dropPointId||null, drop_point_name:p.dropPointName||null,
      consignor_note:p.consignorNote||null, consignee_note:p.consigneeNote||null,
      pickup_address:p.pickup.addr||null,pickup_city:p.pickup.city||null,
      pickup_landmark:p.pickup.land||null,pickup_pincode:p.pickup.pin||null,
      total_pieces:p.pieces||1,total_weight_kg:p.weight||null,
      freight_total:p.freight||0,total_loading_charges:p.loading||0,
      docket_charges:p.docket||0,grand_total:p.grand||0,status:'booked'
    }).select('id'))[0];
    if(p.lines.length){
      const arts=await N.articles().catch(()=>[]);
      const byName=Object.fromEntries(arts.map(a=>[a.name,a.id]));
      ok(await sb.from('booking_lines').insert(p.lines.map(l=>({
        booking_id:booking.id,article_id:byName[l.article]||null,
        description:l.desc||l.article,quantity:l.qty,uom:l.uom||'fixed',
        actual_weight_kg:l.awt||null,billable_weight:l.bwt,
        freight_per_qty:l.rate,loading_per_uom:0,
        freight_basis:(l.basis||p.freightBasis||'weight'),
        freight_total:(l.qty||1)*(((l.basis||p.freightBasis)==='nos')?1:(l.bwt||0))*(l.rate||0)}))));}
    const items=ok(await sb.from('consignment_items').insert(
      Array.from({length:p.pieces||1},(_,i)=>({booking_id:booking.id,
        waybill_number:lr+'-'+(i+1),sequence:i+1,current_status:'booked',
        current_facility_id:origin.id}))).select('id'));
    await sb.from('scan_events').insert(items.map(it=>({item_id:it.id,booking_id:booking.id,
      scan_type:'booked',facility_id:origin.id,scanned_by:by,
      note:(p.channel==='online'?'Booked online':'Booked at counter')})));
    if(p.invoices && p.invoices.length){
      try{ await N.saveInvoices(booking.id,p.invoices); }
      catch(e){ console.warn('invoices not saved:',e.message); }
    }
    return {lr,id:booking.id};
  };
})();

/* ---- MASTERS CRUD (live) ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const ROLE_UI2DB={admin:'admin',booking_branch:'booking_agent'};
  const ROLE_DB2UI={admin:'admin',dispatcher:'admin',accountant:'admin',
                    booking_agent:'booking_branch'};
  async function facId(code){
    if(!code) return null;
    const c=String(code).split('—')[0].split('-—')[0].trim();
    if(!c || c.toLowerCase().startsWith('(no')) return null;
    const F=await N.facilities(true);
    if(F.byCode[c]) return F.byCode[c].id;
    // tolerate a hand-typed code in any case
    const hit=F.list.find(f=>f.code.toLowerCase()===c.toLowerCase());
    if(hit) return hit.id;
    throw new Error('Branch code "'+c+'" not found in Branches & lines');
  }
  N.masters={
    ROLE_UI2DB, ROLE_DB2UI,
    async loadUsers(){
      const d=ok(await sb.from('users')
        .select('id,full_name,phone,role,is_active,contact_email,facility:facility_id(code)')
        .not('role','eq','driver').order('full_name'));
      return d.map(u=>({_id:u.id,name:u.full_name,phone:u.phone||'',
        role:ROLE_DB2UI[u.role]||'admin',branch:u.facility?u.facility.code:'',
        contact:u.contact_email||'', active:u.is_active}));
    },
    async saveUser(v,id){
      const body={full_name:v.name,phone:v.phone,
        role:ROLE_UI2DB[v.role]||'admin',facility_id:await facId(v.branch),
        contact_email:v.contact||null};
      if(id) ok(await sb.from('users').update(body).eq('id',id));
      else ok(await sb.from('users').insert(Object.assign(body,{
        password_hash:'db-managed',      // real hash lives in staff_credentials
        is_active:true,must_change_password:true})));
    },
    async loadDrivers(){
      const d=ok(await sb.from('drivers')
        .select('id,license_number,license_expiry,user:user_id(id,full_name,phone,is_active)')
        .order('created_at'));
      return d.map(x=>({_id:x.id,_uid:x.user?x.user.id:null,
        name:x.user?x.user.full_name:'—',phone:x.user?x.user.phone||'':'',
        lic:x.license_number||'',exp:x.license_expiry||'',
        active:x.user?x.user.is_active:true}));
    },
    async saveDriver(v,row){
      if(row&&row._uid){
        ok(await sb.from('users').update({full_name:v.name,phone:v.phone}).eq('id',row._uid));
        ok(await sb.from('drivers').update({license_number:v.lic,
          license_expiry:v.exp||null}).eq('id',row._id));
      }else{
        const u=ok(await sb.from('users').insert({full_name:v.name,phone:v.phone,
          role:'driver',password_hash:'db-managed',   // real hash lives in staff_credentials
          is_active:true,must_change_password:true}).select('id'))[0];
        ok(await sb.from('drivers').insert({user_id:u.id,license_number:v.lic,
          license_expiry:v.exp||null}));
      }
    },
    async loadVehicles(){
      const d=ok(await sb.from('vehicles')
        .select('id,label,registration,capacity_kg,status').order('label'));
      return d.map(v=>({_id:v.id,label:v.label,reg:v.registration,
        cap:v.capacity_kg?String(Math.round(v.capacity_kg)):'',
        active:v.status!=='out_of_service'}));
    },
    async saveVehicle(v,id){
      const body={label:v.label,registration:v.reg,
        capacity_kg:v.cap?parseFloat(v.cap):null};
      if(id) ok(await sb.from('vehicles').update(body).eq('id',id));
      else ok(await sb.from('vehicles').insert(Object.assign(body,{status:'available'})));
    },
    async loadArticles(){
      const d=ok(await sb.from('articles')
        .select('id,name,default_uom,is_active').order('name'));
      return d.map(a=>({_id:a.id,name:a.name,uom:a.default_uom,active:a.is_active}));
    },
    async saveArticle(v,id){
      const body={name:v.name,default_uom:v.uom||'kg'};
      if(id) ok(await sb.from('articles').update(body).eq('id',id));
      else ok(await sb.from('articles').insert(Object.assign(body,{is_active:true})));
    },
    async loadHelpers(){
      const d=ok(await sb.from('helpers')
        .select('id,full_name,phone,is_active,facility:facility_id(code)').order('full_name'));
      return d.map(h=>({_id:h.id,name:h.full_name,phone:h.phone||'',
        branch:h.facility?h.facility.code:'',active:h.is_active}));
    },
    async saveHelper(v,id){
      const body={full_name:v.name,phone:v.phone||null,facility_id:await facId(v.branch)};
      if(id) ok(await sb.from('helpers').update(body).eq('id',id));
      else ok(await sb.from('helpers').insert(Object.assign(body,{is_active:true})));
    },
    async loadFacilities(){
      const d=ok(await sb.from('facilities')
        .select('id,code,name,kind,city,phone,email,address,is_active').order('name'));
      return d.map(f=>({_id:f.id,code:f.code,name:f.name,kind:f.kind,
        city:f.city||'',phone:f.phone||'',email:f.email||'',address:f.address||'',active:f.is_active}));
    },
    async saveFacility(v,id){
      const body={code:v.code,name:v.name,kind:v.kind||'branch',city:v.city||null,
        phone:v.phone||null,email:v.email||null,address:v.address||null};
      if(id) ok(await sb.from('facilities').update(body).eq('id',id));
      else ok(await sb.from('facilities').insert(Object.assign(body,{is_active:true})));
    },
    async setActive(tab,row,on){
      if(tab==='users')    return ok(await sb.from('users').update({is_active:on}).eq('id',row._id));
      if(tab==='drivers')  return ok(await sb.from('users').update({is_active:on}).eq('id',row._uid));
      if(tab==='vehicles') return ok(await sb.from('vehicles')
                                  .update({status:on?'available':'out_of_service'}).eq('id',row._id));
      if(tab==='articles') return ok(await sb.from('articles').update({is_active:on}).eq('id',row._id));
      if(tab==='helpers')   return ok(await sb.from('helpers').update({is_active:on}).eq('id',row._id));
      if(tab==='droppoints')return ok(await sb.from('drop_points').update({is_active:on}).eq('id',row._id));
      if(tab==='facilities')return ok(await sb.from('facilities').update({is_active:on}).eq('id',row._id));
    }
  };
  // replace facilities() with a refreshable version (cache bust after edits)
  let cache=null;
  /* This is the facilities loader the whole app actually uses — it overrides
     the earlier one and returns parent_facility_id as well.

     Like that one, it cached only the finished RESULT, so several sections
     starting together each saw an empty cache and each fired the same query.
     Every section then waited its own round trip, which is why a page arrived
     piece by piece. Caching the in-flight promise means the first caller
     queries and the rest wait on that same request. */
  let inflight=null;
  N.facilities=async function(fresh){
    if(fresh){ cache=null; inflight=null; }
    if(cache)return cache;
    if(inflight)return inflight;
    inflight=(async()=>{
      try{
        const d=ok(await sb.from('facilities')
          .select('id,code,name,kind,city,is_active,parent_facility_id').eq('is_active',true).order('name'));
        cache={list:d,byCode:Object.fromEntries(d.map(f=>[f.code,f])),
               byId:Object.fromEntries(d.map(f=>[f.id,f]))};
        return cache;
      } finally { inflight=null; }   // a failure must not poison the next attempt
    })();
    return inflight;
  };
})();

/* ---- remaining live helpers (settings, complaints, public branch list) ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  N.onlineOriginBranch=async function(){
    try{
      const s=ok(await sb.from('app_settings').select('value').eq('key','online_origin_branch').limit(1));
      if(s.length && s[0].value) return s[0].value.trim();
    }catch(e){}
    const F=await N.facilities();
    const first=F.list.find(f=>f.kind==='branch'||f.kind==='hub');
    return first?first.code:null;
  };
  N.settings=async function(){
    const d=ok(await sb.from('app_settings').select('key,value'));
    return Object.fromEntries(d.map(r=>[r.key,r.value]));
  };
  N.fileComplaint=async function(c){
    const t=ok(await sb.rpc('next_ticket'));
    let bid=null;
    if(c.lr){const b=ok(await sb.from('bookings').select('id').eq('booking_number',c.lr).limit(1));
      if(b.length)bid=b[0].id;}
    ok(await sb.from('complaints').insert({ticket_no:t,booking_id:bid,lr_number:c.lr||null,
      phone:c.phone,category:c.category,message:c.message||null}));
    return t;
  };
  N.publicBranches=async function(){
    return ok(await sb.from('facilities')
      .select('code,name,kind,city,address,phone').eq('is_active',true)
      .in('kind',['branch','hub']).order('name'));
  };
  N.myTrips=async function(phone){
    const u=ok(await sb.from('users').select('id').eq('phone',phone).limit(1));
    if(!u.length)return [];
    const d=ok(await sb.from('drivers').select('id').eq('user_id',u[0].id).limit(1));
    if(!d.length)return [];
    return ok(await sb.from('trips').select(
      'trip_number,status,open_km,close_km,diesel_litres,'+
      'origin:origin_facility_id(name),dest:destination_facility_id(name)')
      .eq('driver_id',d[0].id).order('created_at',{ascending:false}).limit(20));
  };
  N.dayCloseToday=async function(){
    const d=ok(await sb.from('branch_day_close')
      .select('status,submitted_at,facility:facility_id(code,name)')
      .eq('close_date',n2kTodayLocal()));
    return d;
  };
})();

/* ---- staff authentication INSIDE THE DATABASE (mobile + password, no e-mail) ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const DEST={admin:{dest:'n2k_dispatch.html',lbl:'Dashboard',label:'Admin'},
              booking_agent:{dest:'n2k_agent_booking.html',lbl:'Cargo booking',label:'Booking branch'},
              driver:{dest:'n2k_driver.html',lbl:'Driver app — today\u2019s stops',label:'Driver'}};
  const shape=(r)=>{
    const m=DEST[r.role];
    if(!m) return null;                       // e.g. a driver record — not an app user
    return {name:r.full_name,roleKey:r.role,role:m.label+(r.branch_code?' · '+r.branch_code:''),
            dest:m.dest,lbl:m.lbl,branch:r.branch_code||null,branchName:r.branch_name||null,
            active:r.active!==false,mustSet:r.has_password===false,mustChange:!!r.must_change};
  };
  // step 1: is this number staff? does it have a password yet?
  N.findStaff=async function(phone){
    const d=ok(await sb.rpc('staff_status',{p_phone:phone}));
    if(!d||!d.length) return {unknown:true};
    const s=shape(d[0]);
    if(!s) return {notAllowed:true,name:d[0].full_name||'',role:d[0].role};
    return {staff:s};
  };
  // step 2a: verify password in the database
  N.staffSignIn=async function(phone,password){
    const d=ok(await sb.rpc('staff_login',{p_phone:phone,p_password:password}));
    if(!d||!d.length) throw new Error('Wrong password. Ask your admin to reset it.');
    const s=shape(d[0]);
    if(!s) throw new Error('This account is not allowed to sign in. Ask your admin.');
    N.authVia='database';
    return {staff:s,mustChange:!!d[0].must_change};
  };
  // step 2b: first-time set-up (only when no password exists yet)
  N.staffFirstPassword=async function(phone,password){
    ok(await sb.rpc('staff_set_initial_password',{p_phone:phone,p_password:password}));
    return N.staffSignIn(phone,password);
  };
  // change own password (old required)
  N.staffChangePassword=async function(phone,oldPass,newPass){
    ok(await sb.rpc('staff_change_password',{p_phone:phone,p_old:oldPass,p_new:newPass}));
    return true;
  };
  // admin sets/resets any staff password, proving their own identity
  N.adminSetPassword=async function(adminPhone,adminPass,targetPhone,newPass){
    ok(await sb.rpc('admin_set_password',{p_admin_phone:adminPhone,p_admin_password:adminPass,
      p_target_phone:targetPhone,p_new_password:newPass}));
    return true;
  };
})();

/* ---- account sheet: per-line daily figures ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const today=()=>{const t=new Date();t.setHours(0,0,0,0);return t;};
  N.todayLocal=n2kTodayLocal;
  // auto-counts per destination line for one branch, today
  /* One row per RUN this branch created today — not per destination branch.

     The old version grouped by the destination of the consignments booked, and
     tried to find a matching trip on trips.destination_facility_id. Runs are
     built around LINES now, so that match failed and every vehicle, driver and
     KM box came back empty. Worse, it asked Nambiyur to enter the vehicle and
     driver for Salem and Trichy — branches it does not operate and cannot know
     the crew of.

     A branch closes what it DISPATCHED. Everything below comes from the run
     itself, so there is nothing to retype. */
  N.lineSheet=async function(branchCode){
    const F=await N.facilities();
    const f=F.byCode[branchCode];
    if(!f) throw new Error('branch '+branchCode+' not found');
    /* The LOCAL date, not the UTC one. today() returns local midnight, and
       .toISOString() converts that back to UTC — which in India is 18:30 the
       PREVIOUS day. So the lookup was asking for yesterday's runs every day of
       the year, and the day close always came up empty. */
    const d0=n2kTodayLocal();

    const runs=ok(await sb.from('run_summary').select('*')
      .eq('origin_code',branchCode).eq('run_date',d0).order('trip_number'));
    if(!runs.length) return [];

    /* Which of these runs have already had their expenses submitted today?
       Without this the sheet keeps offering a run that was closed and
       submitted an hour ago, and the agent cannot tell what is still
       outstanding from what is finished. */
    let done=new Set();
    try{
      const dc=ok(await sb.from('branch_day_close').select('id')
        .eq('facility_id',f.id).eq('close_date',d0));
      if(dc.length){
        const dl=ok(await sb.from('day_trip_lines')
          .select('trip_id').in('day_close_id',dc.map(x=>x.id)));
        dl.forEach(x=>{ if(x.trip_id) done.add(x.trip_id); });
      }
    }catch(e){ console.warn('submitted runs unknown',e.message); }

    // the consignments on each run, for counts and income
    const ids=runs.map(r=>r.id);
    let man=[];
    try{
      // trip_manifest has no total_pieces or booking status of its own — it is
      // one row per PIECE, and current_status is the piece's status
      man=ok(await sb.from('trip_manifest')
        .select('trip_id,booking_id,booking_number,payment_type,grand_total,current_status')
        .in('trip_id',ids));
    }catch(e){ console.warn('manifest unavailable',e.message); }

    const byTrip={};
    man.forEach(x=>{
      const t=byTrip[x.trip_id]||(byTrip[x.trip_id]={seen:new Set(),delivered:0,
        undelivered:0,pending:[],income:0,inc_paid:0,inc_topay:0,inc_onacc:0,inc_oatp:0});
      // one row per PIECE: count pieces here, but the money and the LR only once
      if(x.current_status==='delivered') t.delivered++; else t.undelivered++;
      if(t.seen.has(x.booking_id)) return;
      t.seen.add(x.booking_id);
      if(x.current_status!=='delivered') t.pending.push(x.booking_number);
      const amt=parseFloat(x.grand_total)||0;
      t.income+=amt;
      if(x.payment_type==='prepaid')                t.inc_paid  += amt;
      else if(x.payment_type==='to_pay')            t.inc_topay += amt;
      else if(x.payment_type==='on_account')        t.inc_onacc += amt;
      else if(x.payment_type==='on_account_to_pay') t.inc_oatp  += amt;
    });

    return runs.map(r=>{
      const t=byTrip[r.id]||{delivered:0,undelivered:0,pending:[],income:0,
        inc_paid:0,inc_topay:0,inc_onacc:0,inc_oatp:0};
      return {
        code:r.trip_number,
        name:r.lines_covered||r.trip_number,
        tripId:r.id,
        facilityId:null,
        // everything below is already known: the Road Map recorded the crew and
        // opening KM, Delivery recorded the closing KM and diesel
        vehicle_id:r.vehicle_id||null, driver_id:r.driver_id||null, helper_id:r.helper_id||null,
        vehicleLabel:r.vehicle||null, driverLabel:r.driver||null, helperLabel:r.helper||null,
        open_km:r.open_km, close_km:r.close_km, diesel:r.diesel_litres,
        loaded:r.pieces||0,
        delivered:t.delivered, undelivered:t.undelivered,
        pending:t.pending, undelLrCount:t.pending.length,
        income:t.income, inc_paid:t.inc_paid, inc_topay:t.inc_topay,
        inc_onacc:t.inc_onacc, inc_oatp:t.inc_oatp,
        closed:!!r.closed_at, confirmed:!!r.confirmed_at,
        submitted:done.has(r.id)
      };
    });
  };
  // dropdown sources (active only)
  N.crewOptions=async function(){
    const [veh,drv,hlp]=await Promise.all([
      sb.from('vehicles').select('id,label,registration,capacity_kg,status').order('label'),
      sb.from('drivers').select('id,user:user_id(full_name,is_active)'),
      sb.from('helpers').select('id,full_name,is_active').order('full_name')]);
    return {
      vehicles:(veh.data||[]).filter(v=>v.status!=='out_of_service')
        .map(v=>({id:v.id,label:v.label+' · '+v.registration,
                  type:(parseFloat(v.capacity_kg)>=5000?'Truck':'LCV')})),
      drivers:(drv.data||[]).filter(d=>d.user&&d.user.is_active)
        .map(d=>({id:d.id,label:d.user.full_name})),
      helpers:(hlp.data||[]).filter(h=>h.is_active).map(h=>({id:h.id,label:h.full_name}))
    };
  };
  // save the whole sheet: day close + one row per line
  N.saveAccountSheet=async function(branchCode,lines,cash,submit){
    const F=await N.facilities();
    const f=F.byCode[branchCode];
    if(!f) throw new Error('branch not found');
    const u=N.session.get();
    let by=null;
    if(u&&u.phone){const ur=ok(await sb.from('users').select('id').eq('phone',u.phone).limit(1));
      if(ur.length)by=ur[0].id;}
    const dc=ok(await sb.from('branch_day_close').upsert({
      facility_id:f.id, close_date:n2kTodayLocal(),
      status:submit?'submitted':'draft',
      submitted_at:submit?new Date().toISOString():null, submitted_by:by,
      cash_received:cash.received||0, cash_on_hand:cash.onhand||0,
      opening_balance:cash.opening||0, amt_from_ho:cash.ho||0, notes:cash.notes||null
    },{onConflict:'facility_id,close_date'}).select('id'))[0];
    await sb.from('day_trip_lines').delete().eq('day_close_id',dc.id);
    if(lines.length) ok(await sb.from('day_trip_lines').insert(lines.map(l=>({
      // a row is a RUN now, so record which trip it was: the account sheet can
      // then trace a day's figures back to the vehicle that earned them
      day_close_id:dc.id, line_facility_id:l.facilityId||null,
      line_label:l.name, trip_id:l.tripId||null,
      vehicle_id:l.vehicle_id||null, vehicle_type:l.vehicle_type||null,
      driver_id:l.driver_id||null, helper_id:l.helper_id||null,
      open_km:l.open_km||null, close_km:l.close_km||null, diesel_litres:l.diesel||null,
      loaded_qty:l.loaded||0, delivered_qty:l.delivered||0, undelivered_qty:l.undelivered||0,
      undelivered_lrs:l.pendingText||null,
      fuel_expense:l.fuel||0, loading_expense:l.loading||0,
      maintenance_expense:l.maint||0,
      mamool_expense:l.mamool||0, misc_expense:l.misc||0,
      driver_wage:l.dwage||0, helper_wage:l.hwage||0, income:l.income||0,
      undelivered_lr_count:l.undelLrCount||0
    }))));
    return dc.id;
  };
  // admin: read a branch's submitted sheet
  N.accountSheetFor=async function(branchCode,date){
    return ok(await sb.from('account_sheet').select('*')
      .eq('branch_code',branchCode)
      .eq('close_date',date||n2kTodayLocal()));
  };
})();

/* ---- loading / manifest: maps consignments to vehicle + driver + helper ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const dayStart=()=>{const t=new Date();t.setHours(0,0,0,0);return t.toISOString();};

  // destinations with bookings waiting to be loaded today
  N.pendingDestinations=async function(branchCode){
    const F=await N.facilities(); const f=F.byCode[branchCode];
    if(!f) throw new Error('branch not found');
    const b=ok(await sb.from('bookings').select(
      'id,total_pieces,status,dest:destination_facility_id(code,name),destination_facility_id')
      .eq('origin_facility_id',f.id).in('status',['booked','received_at_origin','sorted'])
      .gte('created_at',dayStart()));
    const m={};
    b.forEach(r=>{const k=r.dest?r.dest.code:null; if(!k)return;
      m[k]=m[k]||{code:k,name:r.dest.name,id:r.destination_facility_id,bookings:0,pieces:0};
      m[k].bookings++; m[k].pieces+=r.total_pieces||0;});
    return Object.values(m).sort((a,b)=>a.name.localeCompare(b.name));
  };

  // the LR list to tick for one destination
  N.loadableBookings=async function(branchCode,destCode){
    const F=await N.facilities();
    const f=F.byCode[branchCode], d=F.byCode[destCode];
    if(!f||!d) throw new Error('facility not found');
    return ok(await sb.from('bookings').select(
      'id,booking_number,receiver_name,receiver_address,total_pieces,payment_type,grand_total,status')
      .eq('origin_facility_id',f.id).eq('destination_facility_id',d.id)
      .in('status',['booked','received_at_origin','sorted'])
      .gte('created_at',dayStart()).order('created_at'));
  };

  // create the trip and load the ticked LRs onto it
  N.createTripAndLoad=async function(p){
    const F=await N.facilities();
    const o=F.byCode[p.branchCode], d=F.byCode[p.destCode];
    if(!o||!d) throw new Error('facility not found');
    if(!p.bookingIds||!p.bookingIds.length) throw new Error('tick at least one LR to load');
    const no=ok(await sb.rpc('next_trip_no',{p_branch:p.branchCode}));
    const trip=ok(await sb.from('trips').insert({
      trip_number:no, vehicle_id:p.vehicleId||null, driver_id:p.driverId||null,
      helper_id:p.helperId||null, origin_facility_id:o.id, destination_facility_id:d.id,
      status:'loading'
    }).select('id,trip_number'))[0];
    const items=ok(await sb.from('consignment_items').select('id,booking_id')
      .in('booking_id',p.bookingIds));
    // never load a cancelled consignment, even if a stale id reaches here
    const live=ok(await db().from('bookings').select('id')
      .in('id',p.bookingIds).is('cancelled_at',null)).map(b=>b.id);
    if(live.length!==p.bookingIds.length)
      throw new Error('One or more of those consignments has been cancelled — refresh and try again');
    if(items.length){
      ok(await sb.from('trip_items').insert(items.map(i=>({trip_id:trip.id,item_id:i.id}))));
      await sb.from('consignment_items').update({current_status:'loaded'})
        .in('id',items.map(i=>i.id));
      await sb.from('scan_events').insert(items.map(i=>({item_id:i.id,booking_id:i.booking_id,
        scan_type:'loaded',facility_id:o.id,trip_id:trip.id,note:'Loaded onto '+trip.trip_number})));
    }
    await sb.from('bookings').update({status:'loaded'}).in('id',p.bookingIds);
    return {tripId:trip.id,tripNumber:trip.trip_number,pieces:items.length};
  };

  // today's trips for a branch, with load counts
  N.todayTrips=async function(branchCode){
    const F=await N.facilities(); const f=F.byCode[branchCode];
    if(!f) return [];
    const t=ok(await sb.from('trips').select(
      'id,trip_number,status,departed_at,open_km,close_km,diesel_litres,'+
      'dest:destination_facility_id(code,name),vehicle:vehicle_id(label),'+
      'driver:driver_id(user:user_id(full_name)),helper:helper_id(full_name)')
      .eq('origin_facility_id',f.id).gte('created_at',dayStart())
      .order('created_at',{ascending:false}));
    for(const x of t){
      const c=await sb.from('trip_items').select('item_id',{count:'exact',head:true}).eq('trip_id',x.id);
      x.pieces=c.count||0;
    }
    return t;
  };

  N.departTrip=async function(tripId){
    ok(await sb.from('trips').update({status:'departed',departed_at:new Date().toISOString()}).eq('id',tripId));
    const ti=ok(await sb.from('trip_items').select('item_id').eq('trip_id',tripId));
    if(ti.length){
      const items=ok(await sb.from('consignment_items').select('id,booking_id').in('id',ti.map(x=>x.item_id)));
      await sb.from('consignment_items').update({current_status:'in_transit'}).in('id',items.map(i=>i.id));
      await sb.from('scan_events').insert(items.map(i=>({item_id:i.id,booking_id:i.booking_id,
        scan_type:'departed',trip_id:tripId,note:'Trip departed'})));
      await sb.from('bookings').update({status:'in_transit'})
        .in('id',[...new Set(items.map(i=>i.booking_id))]);
    }
    return true;
  };

  // driver app: only what is actually on my vehicle
  N.myLoad=async function(phone){
    const u=ok(await sb.from('users').select('id').eq('phone',phone).limit(1));
    if(!u.length) return [];
    const d=ok(await sb.from('drivers').select('id').eq('user_id',u[0].id).limit(1));
    if(!d.length) return [];
    const t=ok(await sb.from('trips').select('id,trip_number,status')
      .eq('driver_id',d[0].id).in('status',['loading','departed','in_transit','arrived'])
      .order('created_at',{ascending:false}));
    if(!t.length) return [];
    const rows=ok(await sb.from('trip_manifest').select('*')
      .in('trip_id',t.map(x=>x.id)).neq('current_status','delivered'));
    const byBooking={};
    rows.forEach(r=>{ byBooking[r.booking_id]=byBooking[r.booking_id]||{
      id:r.booking_id,booking_number:r.booking_number,receiver_name:r.receiver_name,
      receiver_address:r.receiver_address,payment_type:r.payment_type,
      grand_total:r.grand_total,trip_number:r.trip_number,total_pieces:0};
      byBooking[r.booking_id].total_pieces++; });
    return Object.values(byBooking);
  };
})();

/* ---- repeat customers: fetch everything we know by mobile number ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  // name + GSTIN + company flag + saved addresses, for sender OR receiver
  N.partyByPhone=async function(phone){
    const out={found:false,name:'',gstin:'',kind:'individual',addresses:[],source:''};
    if(!/^[6-9]\d{9}$/.test(phone)) return out;
    // 1. as a sender (they have a customer record)
    const c=ok(await sb.from('customers').select('id,name,gstin,kind')
      .eq('contact_phone',phone).limit(1));
    if(c.length){out.found=true;out.name=c[0].name||'';out.gstin=c[0].gstin||'';
      out.kind=c[0].kind||'individual';out.source='customer';}
    // 2. saved addresses (works for senders and receivers alike)
    const a=ok(await sb.from('customer_addresses')
      .select('label,door_street,city,landmark,pincode,is_default').eq('phone',phone));
    out.addresses=a.map(x=>({label:x.label||'Saved',door:x.door_street,city:x.city||'',
      land:x.landmark||'',pin:x.pincode||'',def:!!x.is_default}));
    if(out.addresses.length) out.found=true;
    // 3. fall back to the last booking where this number was the receiver
    if(!out.name || !out.addresses.length){
      const b=ok(await sb.from('bookings').select(
        'receiver_name,receiver_address,receiver_city,receiver_landmark,receiver_pincode,'+
        'receiver_gstin,receiver_kind,created_at')
        .eq('receiver_phone',phone).order('created_at',{ascending:false}).limit(1));
      if(b.length){
        out.found=true; out.source=out.source||'last booking';
        out.name=out.name||b[0].receiver_name||'';
        out.gstin=out.gstin||b[0].receiver_gstin||'';
        if(b[0].receiver_kind) out.kind=out.kind==='company'?'company':b[0].receiver_kind;
        if(!out.addresses.length && b[0].receiver_address)
          out.addresses=[{label:'Last delivery',door:(b[0].receiver_address||'').split(',')[0].trim(),
            city:b[0].receiver_city||'',land:b[0].receiver_landmark||'',
            pin:b[0].receiver_pincode||'',def:true}];
      }
    }
    return out;
  };
  // remember an address against a mobile number so next time it auto-fills
  N.rememberAddress=async function(phone,a,makeDefault){
    if(!/^[6-9]\d{9}$/.test(phone)||!a||!a.door) return false;
    const ex=ok(await sb.from('customer_addresses').select('id,door_street,is_default').eq('phone',phone));
    const same=ex.find(x=>(x.door_street||'').trim().toLowerCase()===a.door.trim().toLowerCase());
    if(makeDefault) await sb.from('customer_addresses').update({is_default:false}).eq('phone',phone);
    if(same){
      await sb.from('customer_addresses').update({city:a.city||null,landmark:a.land||null,
        pincode:a.pin||null,is_default:makeDefault||same.is_default}).eq('id',same.id);
      return true;
    }
    ok(await sb.from('customer_addresses').insert({phone,label:a.label||'Saved',
      door_street:a.door,city:a.city||null,landmark:a.land||null,pincode:a.pin||null,
      is_default: makeDefault || ex.length===0}));   // first address becomes the default
    return true;
  };
  // saveBooking now also stores the addresses, so the next visit auto-fills
  const _save=N.saveBooking;
  N.saveBooking=async function(p){
    const res=await _save(p);
    try{
      if(p.pickup && p.pickup.addr)
        await N.rememberAddress(p.senderPhone,{label:'Pickup',door:p.pickup.addr,
          city:p.pickup.city,land:p.pickup.land,pin:p.pickup.pin},!!p.senderMakeDefault);
      if(p.address)
        await N.rememberAddress(p.receiverPhone,{label:'Delivery',door:p.address,
          city:p.city,land:p.landmark,pin:p.pincode},!!p.receiverMakeDefault);
    }catch(e){ console.warn('address not remembered:',e.message); }
    return res;
  };
})();

/* ---- arrival / unloading / delivery + shared menu ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};

  // trips heading INTO my branch that have not arrived yet
  N.inboundTrips=async function(branchCode){
    const F=await N.facilities(); const f=F.byCode[branchCode]; if(!f) return [];
    const t=ok(await sb.from('trips').select(
      'id,trip_number,status,departed_at,open_km,close_km,diesel_litres,'+
      'origin:origin_facility_id(code,name),dest:destination_facility_id(code,name,kind),'+
      'vehicle:vehicle_id(label),driver:driver_id(user:user_id(full_name)),helper:helper_id(full_name)')
      .eq('destination_facility_id',f.id).in('status',['departed','in_transit'])
      .order('departed_at',{ascending:false}));
    for(const x of t){
      const c=await sb.from('trip_items').select('item_id',{count:'exact',head:true}).eq('trip_id',x.id);
      x.pieces=c.count||0;
    }
    return t;
  };

  // mark the vehicle arrived; local (line) destinations go straight to delivery
  N.markTripArrived=async function(tripId,closeKm,diesel){
    const tr=ok(await sb.from('trips').select(
      'id,open_km,destination_facility_id,dest:destination_facility_id(kind)').eq('id',tripId).limit(1))[0];
    if(!tr) throw new Error('trip not found');
    if(closeKm!=null && tr.open_km!=null && closeKm < tr.open_km)
      throw new Error('Closing KM ('+closeKm+') cannot be less than opening KM ('+tr.open_km+')');
    const isLocal = tr.dest && tr.dest.kind==='line';
    const nextStatus = isLocal ? 'out_for_delivery' : 'arrived_at_destination';
    const patch={status:'arrived',arrived_at:new Date().toISOString()};
    if(closeKm!=null) patch.close_km=closeKm;
    if(diesel!=null) patch.diesel_litres=diesel;
    ok(await sb.from('trips').update(patch).eq('id',tripId));
    const ti=ok(await sb.from('trip_items').select('item_id').eq('trip_id',tripId));
    if(ti.length){
      const items=ok(await sb.from('consignment_items').select('id,booking_id')
        .in('id',ti.map(x=>x.item_id)));
      await sb.from('consignment_items').update({current_status:nextStatus,
        current_facility_id:tr.destination_facility_id}).in('id',items.map(i=>i.id));
      await sb.from('scan_events').insert(items.map(i=>({item_id:i.id,booking_id:i.booking_id,
        scan_type:nextStatus,facility_id:tr.destination_facility_id,trip_id:tripId,
        note: isLocal?'Arrived on delivery line — out for delivery':'Arrived at destination branch'})));
      await sb.from('bookings').update({status:nextStatus})
        .in('id',[...new Set(items.map(i=>i.booking_id))]);
    }
    return {local:isLocal,next:nextStatus};
  };

  // consignments sitting AT my branch, by stage
  // all LRs this branch is concerned with. scope: 'deliver' | 'booked' | 'all'
  N.deliveryList=async function(branchCode,scope,statuses){
    const F=await N.facilities();
    const f=F.byCode[branchCode];
    const sel='id,booking_number,created_at,status,total_pieces,payment_type,grand_total,delivery_type,'+
      'receiver_name,receiver_phone,receiver_address,drop_point_name,'+
      'customer:customer_id(name,contact_phone),'+
      'origin:origin_facility_id(code,name),dest:destination_facility_id(code,name,kind)';
    // a cancelled consignment is not deliverable: it never travelled
    let q=sb.from('bookings').select(sel).is('cancelled_at',null)
      .order('created_at',{ascending:false}).limit(400);
    if(statuses&&statuses.length) q=q.in('status',statuses);
    if(f && scope!=='all'){
      const mineDest=F.list.filter(x=>x.id===f.id||x.parent_facility_id===f.id).map(x=>x.id);
      if(scope==='booked') q=q.eq('origin_facility_id',f.id);
      else q=q.in('destination_facility_id',mineDest);
    }
    return ok(await q);
  };

  N.atBranch=async function(branchCode,statuses){
    const F=await N.facilities(); const f=F.byCode[branchCode]; if(!f) return [];
    const mine=F.list.filter(x=>x.id===f.id||x.parent_facility_id===f.id).map(x=>x.id);
    let q=sb.from('bookings').select(
      'id,booking_number,created_at,receiver_name,receiver_phone,receiver_address,receiver_city,'+
      'total_pieces,payment_type,grand_total,status,delivery_type,drop_point_name,'+
      'customer:customer_id(name,contact_phone),'+
      'origin:origin_facility_id(code,name),dest:destination_facility_id(code,name,kind)')
      .in('destination_facility_id',mine).is('cancelled_at',null).order('created_at',{ascending:true}).limit(500);
    if(statuses&&statuses.length) q=q.in('status',statuses);
    return ok(await q);
  };

  N.setBookingStage=async function(bookingIds,stage,note){
    if(!bookingIds.length) return 0;
    const items=ok(await sb.from('consignment_items').select('id,booking_id')
      .in('booking_id',bookingIds));
    await sb.from('consignment_items').update({current_status:stage}).in('booking_id',bookingIds);
    if(items.length) await sb.from('scan_events').insert(items.map(i=>({item_id:i.id,
      booking_id:i.booking_id,scan_type:stage,note:note||null})));
    ok(await sb.from('bookings').update({status:stage}).in('id',bookingIds));
    return bookingIds.length;
  };

  N.deliverBooking=async function(bookingId,info){
    const note='Delivered'+(info&&info.receivedBy?' to '+info.receivedBy:'')+
      (info&&info.cod?' · \u20B9'+info.cod+' collected (To Pay)':'');
    const items=ok(await sb.from('consignment_items').select('id').eq('booking_id',bookingId));
    await sb.from('consignment_items').update({current_status:'delivered',
      delivered_at:new Date().toISOString()}).eq('booking_id',bookingId);
    if(items.length) await sb.from('scan_events').insert(items.map(i=>({item_id:i.id,
      booking_id:bookingId,scan_type:'delivered',note})));
    ok(await sb.from('bookings').update({status:'delivered'}).eq('id',bookingId));

    /* Cash shortage tracking — the "due" figure comes from the booking
       itself, not from whatever the caller passes in, so a shortfall can
       never be under- or over-stated by what the delivery screen happened
       to send. Recorded whenever collected < due, however small — no
       threshold, per the client's call. */
    try{
      const bk=ok(await sb.from('bookings')
        .select('payment_type,grand_total,destination_facility_id').eq('id',bookingId).limit(1))[0];
      const due=(bk&&bk.payment_type==='to_pay')?(parseFloat(bk.grand_total)||0):0;
      const collected=(info&&info.cod!=null)?parseFloat(info.cod)||0:due;
      if(due>0 && collected<due){
        let by=null;
        const me=N.session.get();
        if(me&&me.phone){
          const u=ok(await sb.from('users').select('id').eq('phone',me.phone).limit(1));
          if(u.length) by=u[0].id;
        }
        await sb.from('cod_shortfalls').insert({
          booking_id:bookingId, destination_facility_id:bk.destination_facility_id||null,
          due, collected, short:due-collected, delivered_by:by});
      }
    }catch(e){ console.warn('cod shortfall not recorded:',e.message); }

    return true;
  };
  N.failBooking=async function(bookingId,reason){
    await sb.from('consignment_items').update({current_status:'delivery_failed'}).eq('booking_id',bookingId);
    const items=ok(await sb.from('consignment_items').select('id').eq('booking_id',bookingId));
    if(items.length) await sb.from('scan_events').insert(items.map(i=>({item_id:i.id,
      booking_id:bookingId,scan_type:'delivery_failed',note:reason||'Delivery failed'})));
    ok(await sb.from('bookings').update({status:'delivery_failed'}).eq('id',bookingId));
    return true;
  };

  /* Undelivered, and instead of retrying here it goes back to whoever it was
     originally booked from. Two things happen: the original is marked
     undelivered exactly as failBooking already does, and a brand new
     booking is created — origin = THIS branch (it physically has the
     goods), destination = the original booking's origin (the source) —
     billed On Account, since this is a branch-to-branch movement settled
     later, not a fresh customer transaction. The two stay linked via
     return_of_booking_id so each can show the other. */
  N.returnToSource=async function(bookingId,branchCode,reason){
    await N.failBooking(bookingId,reason);

    const F=await N.facilities();
    const here=F.byCode[branchCode];
    if(!here) throw new Error('Your branch is not set up correctly — ask admin to check Masters');

    const orig=ok(await sb.from('bookings').select(
      'booking_number,customer_id,origin_facility_id,total_pieces,total_weight_kg,'+
      'freight_total,grand_total,scope,delivery_type')
      .eq('id',bookingId).limit(1))[0];
    if(!orig) throw new Error('original booking not found');
    if(!orig.origin_facility_id) throw new Error('This LR has no origin branch on record — cannot return it');

    const cust=orig.customer_id
      ? ok(await sb.from('customers').select('name,contact_phone').eq('id',orig.customer_id).limit(1))[0]
      : null;

    const lr=ok(await sb.rpc('next_lr',{p_branch:branchCode}));
    let by=null;
    const me=N.session.get();
    if(me&&me.phone){
      const u=ok(await sb.from('users').select('id').eq('phone',me.phone).limit(1));
      if(u.length) by=u[0].id;
    }

    const ret=ok(await sb.from('bookings').insert({
      booking_number:lr, channel:'offline', customer_id:orig.customer_id,
      origin_facility_id:here.id, destination_facility_id:orig.origin_facility_id,
      booked_by:by, return_of_booking_id:bookingId,
      receiver_name:(cust&&cust.name)||'—', receiver_phone:(cust&&cust.contact_phone)||null,
      receiver_address:'Return to '+here.code, receiver_kind:'individual',
      payment_type:'on_account', scope:orig.scope||'outstation',
      lr_mode:'system', delivery_type:orig.delivery_type||'OD',
      total_pieces:orig.total_pieces||1, total_weight_kg:orig.total_weight_kg||null,
      freight_total:orig.freight_total||0, total_loading_charges:0, docket_charges:0,
      grand_total:orig.grand_total||0, status:'booked',
      consignor_note:'Return of '+orig.booking_number+(reason?' — '+reason:'')
    }).select('id'))[0];

    const items=ok(await sb.from('consignment_items').insert(
      Array.from({length:orig.total_pieces||1},(_,i)=>({booking_id:ret.id,
        waybill_number:lr+'-'+(i+1),sequence:i+1,current_status:'booked',
        current_facility_id:here.id}))).select('id'));
    await sb.from('scan_events').insert(items.map(it=>({item_id:it.id,booking_id:ret.id,
      scan_type:'booked',facility_id:here.id,scanned_by:by,
      note:'Return of '+orig.booking_number})));

    return {lr, id:ret.id, originalLr:orig.booking_number};
  };

  // Return LRs headed to my branch that haven't shipped yet — created
  // elsewhere (wherever the failed delivery physically was), still sitting
  // there. Shown on Trip so the source branch sees it even before it's on
  // a vehicle, per the client's call — see the migration note on
  // road_map.return_of_booking_id for the reasoning.
  N.returnsAwaitingPickup=async function(branchCode){
    const F=await N.facilities(); const f=F.byCode[branchCode];
    if(!f) return [];
    return ok(await sb.from('bookings').select(
      'id,booking_number,receiver_name,total_pieces,consignor_note,created_at,'+
      'origin:origin_facility_id(code,name)')
      .eq('destination_facility_id',f.id).not('return_of_booking_id','is',null)
      .eq('status','booked').order('created_at',{ascending:false}));
  };

  /* Open cash shortfalls — company-wide for admin (branchCode omitted),
     or one branch's own (as the destination that under-collected) when
     a branch code is given. Shown on the Dashboard, not Delivery — see
     the note on cod_shortfalls in the migration for why. */
  N.codShortfalls=async function(branchCode){
    let facilityIds=null;
    if(branchCode){
      const F=await N.facilities(); const f=F.byCode[branchCode];
      if(!f) return [];
      facilityIds=[f.id];
    }
    let q=sb.from('cod_shortfalls')
      .select('id,booking_id,due,collected,short,delivered_at,'+
        'booking:booking_id(booking_number,receiver_name),'+
        'facility:destination_facility_id(code,name),'+
        'staff:delivered_by(full_name)')
      .is('resolved_at',null).order('delivered_at',{ascending:false});
    if(facilityIds) q=q.in('destination_facility_id',facilityIds);
    const rows=ok(await q);
    return rows.map(r=>({
      id:r.id, booking_id:r.booking_id,
      booking_number:r.booking&&r.booking.booking_number, receiver_name:r.booking&&r.booking.receiver_name,
      branch_code:r.facility&&r.facility.code, branch_name:r.facility&&r.facility.name,
      staff_name:r.staff&&r.staff.full_name,
      due:r.due, collected:r.collected, short:r.short, delivered_at:r.delivered_at}));
  };

  N.resolveCodShortfall=async function(id){
    let by=null;
    const me=N.session.get();
    if(me&&me.phone){
      const u=ok(await sb.from('users').select('id').eq('phone',me.phone).limit(1));
      if(u.length) by=u[0].id;
    }
    ok(await sb.from('cod_shortfalls').update({
      resolved_at:new Date().toISOString(), resolved_by:by}).eq('id',id));
    return true;
  };

  /* ---- one shared menu for every internal page ---- */
  N.mountNav=function(active){
    const me=N.session.get(); if(!me) return;
    const ITEMS=[
      {k:'dispatch', t:'Dashboard',      h:'n2k_dispatch.html',      r:['admin','booking_agent']},
      {k:'booking',  t:'Booking',        h:'n2k_agent_booking.html', r:['booking_agent']},
      {k:'roadmap',  t:'Trip',           h:'n2k_roadmap.html',       r:['booking_agent']},
      {k:'delivery', t:'Delivery',       h:'n2k_delivery.html',      r:['booking_agent']},
      {k:'reports',  t:'Reports',        h:'n2k_reports.html',       r:['admin','booking_agent']},
      // agents reach Masters for the Customers tab only; the page itself
      // hides every other tab from them
      {k:'masters',  t:'Masters',        h:'n2k_masters.html',       r:['admin','booking_agent']}
    ].filter(i=>i.r.includes(me.role));
    const st=document.createElement('style');
    st.textContent=`.n2knav{position:sticky;top:0;z-index:29;display:flex;gap:4px;align-items:center;
      flex-wrap:wrap;background:#2F4079;padding:0 14px}
      .n2knav a{color:rgba(255,255,255,.78);font-family:Inter,sans-serif;font-weight:600;font-size:13.5px;
        padding:11px 13px;text-decoration:none;border-bottom:3px solid transparent}
      .n2knav a:hover{color:#fff}
      .n2knav a.on{color:#fff;border-bottom-color:#C0392B}
      .n2knav .who{margin-left:auto;color:rgba(255,255,255,.7);font-family:Inter,sans-serif;font-size:12.5px;
        display:flex;align-items:center;gap:10px;padding:8px 4px}
      .n2knav .who a{padding:0;border:0;color:#FFD7D2;font-weight:700;font-size:12px}
      @media(max-width:700px){.n2knav{overflow-x:auto;flex-wrap:nowrap}.n2knav .who span{display:none}}`;
    document.head.appendChild(st);
    const bar=document.createElement('div');
    bar.className='n2knav';
    bar.innerHTML=ITEMS.map(i=>`<a href="${i.h}" class="${i.k===active?'on':''}">${i.t}</a>`).join('')+
      `<span class="who"><span>${me.name||''}${me.branch?' · '+me.branch:''}</span>
        <a href="#" id="n2ksignout">Sign out</a></span>`;
    const tb=document.querySelector('.topbar');
    if(tb&&tb.parentNode) tb.parentNode.insertBefore(bar,tb.nextSibling);
    else document.body.insertBefore(bar,document.body.firstChild);
    const so=document.getElementById('n2ksignout');
    if(so) so.addEventListener('click',e=>{e.preventDefault();N.signOut();});
  };
})();

/* ---- dispatch board: one query, six stage counts, correct scoping ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  N.dispatchCounts=async function(branchCode){
    const t=new Date(); t.setHours(0,0,0,0); const tISO=t.toISOString();
    let f=null;
    if(branchCode){ const F=await N.facilities(); f=F.byCode[branchCode]||null; }
    let mine=null;
    if(f){ const F=await N.facilities();
      mine=F.list.filter(x=>x.id===f.id||x.parent_facility_id===f.id).map(x=>x.id); }
    let q=sb.from('bookings')
      .select('id,status,created_at,grand_total,payment_type,origin_facility_id,destination_facility_id').is('cancelled_at',null)
      .order('created_at',{ascending:false}).limit(4000);
    if(f) q=q.or('origin_facility_id.eq.'+f.id+',destination_facility_id.in.('+mine.join(',')+')');
    // two independent reads — the second doesn't need anything from the
    // first, so they go out together rather than one after another
    const [rowsRes,itemsRes]=await Promise.all([
      q,
      sb.from('consignment_items').select('booking_id,delivered_at').gte('delivered_at',tISO).limit(5000)
    ]);
    const rows=ok(rowsRes), items=ok(itemsRes);
    const ids=new Set(rows.map(r=>r.id));
    const deliveredToday=new Set(items.map(i=>i.booking_id).filter(id=>!f||ids.has(id)));
    const pending=rows.filter(r=>r.status!=='delivered'&&r.status!=='returned'&&r.status!=='delivery_failed');
    return {
      booked:    rows.filter(r=>new Date(r.created_at)>=t && (!f||r.origin_facility_id===f.id)).length,
      pending:   pending.length,
      delivered: deliveredToday.size,
      failed:    rows.filter(r=>r.status==='delivery_failed').length,
      value:     rows.filter(r=>new Date(r.created_at)>=t).reduce((a,r)=>a+(parseFloat(r.grand_total)||0),0),
      collect:   pending.filter(r=>r.payment_type==='to_pay').reduce((a,r)=>a+(parseFloat(r.grand_total)||0),0)
    };
  };
})();

/* ---- admin drill-down: the actual LRs behind every count, + LR printing ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const rup=n=>'\u20B9'+Math.round(n||0).toLocaleString('en-IN');
  const dayStart=()=>{const t=new Date();t.setHours(0,0,0,0);return t.toISOString();};

  // the real consignments behind a branch's count
  N.stageBookings=async function(branchCode,kind){
    const F=await N.facilities(); const f=F.byCode[branchCode];
    if(!f) return {bookings:[],trips:[]};
    const sel='id,booking_number,created_at,status,total_pieces,total_weight_kg,payment_type,'+
      'grand_total,delivery_type,receiver_name,receiver_phone,receiver_address,'+
      'customer:customer_id(name,contact_phone),origin:origin_facility_id(code,name),'+
      'dest:destination_facility_id(code,name)';
    let q=sb.from('bookings').select(sel);
    if(kind==='loading') q=q.eq('origin_facility_id',f.id)
      .in('status',['booked','received_at_origin','sorted']).order('created_at');
    else if(kind==='unloading') q=q.eq('destination_facility_id',f.id)
      .in('status',['arrived_at_destination','arrived_at_hub']).order('created_at');
    else q=q.eq('destination_facility_id',f.id)
      .in('status',['out_for_delivery','delivery_failed','delivered'])
      .gte('created_at',new Date(Date.now()-7*864e5).toISOString()).order('created_at',{ascending:false});
    const bookings=ok(await q);
    let trips=[];
    if(kind==='unloading'){
      trips=ok(await sb.from('trips').select(
        'id,trip_number,status,departed_at,open_km,'+
        'origin:origin_facility_id(code,name),vehicle:vehicle_id(label),'+
        'driver:driver_id(user:user_id(full_name)),helper:helper_id(full_name)')
        .eq('destination_facility_id',f.id).in('status',['departed','in_transit'])
        .order('departed_at',{ascending:false}));
      for(const t of trips){
        const c=await sb.from('trip_items').select('item_id',{count:'exact',head:true}).eq('trip_id',t.id);
        t.pieces=c.count||0;
      }
    }
    return {bookings,trips};
  };

  // full LR document for any booking, printed in its own window
  // ---- Code 39 barcode as inline SVG (no library, prints cleanly) ----
  const C39={'0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw',
    '5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn',
    'A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn',
    'F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn',
    'K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn',
    'P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn',
    'U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn',
    'Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','*':'nwnnwnwnn'};
  N.barcodeSVG=function(text,h){
    const t='*'+String(text||'').toUpperCase().replace(/[^0-9A-Z\-. ]/g,'')+'*';
    const NW=1, WD=3, GAP=1, H=h||30;
    let x=0, bars='';
    for(const ch of t){
      const pat=C39[ch]; if(!pat) continue;
      for(let k=0;k<9;k++){
        const w=(pat[k]==='w')?WD:NW;
        if(k%2===0) bars+=`<rect x="${x}" y="0" width="${w}" height="${H}"/>`;
        x+=w;
      }
      x+=GAP;
    }
    return `<svg class="bc" viewBox="0 0 ${x} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"
      shape-rendering="crispEdges" fill="#000">${bars}</svg>`;
  };

  // ---- ONE LR copy. Used for the on-screen preview and, twice, for printing ----
  N.lrDoc=function(b,copyLabel){
    const rup=n=>'\u20B9'+Math.round(n||0).toLocaleString('en-IN');
    const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const payL={prepaid:'PAID',to_pay:'TO PAY',on_account:'ON ACCOUNT',
                on_account_to_pay:'ON ACCOUNT TO PAY'}[b.payment_type]||'\u2014';
    const isDue = b.payment_type==='to_pay';
    const when=new Date(b.created_at);
    const o=b.origin||{}, d=b.dest||{};
    const contact=[o.phone&&('Ph '+o.phone), o.email].filter(Boolean).join('  \u00b7  ');
    const T={qty:0,awt:0,bwt:0,amt:0};
    (b.lines||[]).forEach(l=>{
      const amt=(l.freight_total!=null)?parseFloat(l.freight_total)
        :((l.quantity||1)*(((l.freight_basis||b.freight_basis)==='nos')?1:(l.billable_weight||0))*(l.freight_per_qty||0));
      T.qty+=parseFloat(l.quantity)||0; T.awt+=parseFloat(l.actual_weight_kg)||0;
      T.bwt+=parseFloat(l.billable_weight)||0; T.amt+=amt||0;
    });
    const rows=(b.lines||[]).map((l,i)=>`<tr><td>${i+1}</td>
        <td>${esc((l.article&&l.article.name)||l.description||'\u2014')}</td>
        <td class="r">${l.quantity||''}</td><td class="r">${l.actual_weight_kg??'\u2014'}</td>
        <td class="r">${l.billable_weight??''}</td>
        <td>${((l.freight_basis||b.freight_basis)==='nos')?'Nos':'Weight'}</td>
        <td class="r">\u20B9${l.freight_per_qty||0}</td>
        <td class="r">${rup(l.freight_total!=null?l.freight_total:
            ((l.quantity||1)*(((l.freight_basis||b.freight_basis)==='nos')?1:(l.billable_weight||0))*(l.freight_per_qty||0)))}</td></tr>`).join('')
      || '<tr><td colspan="7" style="color:#888">No article lines recorded</td></tr>';
    const invs=(b.invoices||[]).filter(x=>x.invoice_no||x.eway_bill_number||x.invoice_value);
    const dnum=v=>v==null||v===''?'\u2014':rup(v);
    const invBlock = invs.length ? `
      <div class="lrinv">
        <table><thead><tr><th>Invoice no.</th><th>Date</th><th class="r">Invoice value</th>
          <th class="r">GST</th><th>E-Way Bill no.</th></tr></thead>
          <tbody>${invs.map(x=>`<tr>
            <td><b>${esc(x.invoice_no||'\u2014')}</b></td>
            <td>${x.invoice_date?new Date(x.invoice_date).toLocaleDateString('en-IN'):'\u2014'}</td>
            <td class="r">${dnum(x.invoice_value)}</td>
            <td class="r">${dnum(x.gst_value)}</td>
            <td class="ewb">${esc(x.eway_bill_number||'\u2014')}</td></tr>`).join('')}
          ${invs.length>1?`<tr class="it"><td colspan="2">Total ${invs.length} invoices</td>
            <td class="r">${rup(invs.reduce((a,x)=>a+(parseFloat(x.invoice_value)||0),0))}</td>
            <td class="r">${rup(invs.reduce((a,x)=>a+(parseFloat(x.gst_value)||0),0))}</td><td></td></tr>`:''}
          </tbody></table></div>`
      : (b.eway_bill_number ? `<div class="lrinv one">E-Way Bill: <b>${esc(b.eway_bill_number)}</b></div>` : '');
    // party line: NAME, TOWN — uppercased by CSS so the stored value is untouched
    const town = v => esc(v||'').trim();
    const conTown = town(b.pickup_city) || town(o.name);
    const cneTown = town(b.drop_point_name) || town(b.receiver_city) || town(d.name);
    const hubBlock = (f,label) => `
        <div><span class="h">${label}</span>
          <div class="nm">${esc(f.code||'')}${f.name?'&nbsp;&nbsp;'+esc(f.name):''}</div>
          ${f.address?'<div class="ad">'+esc(f.address)+'</div>':''}
          ${f.phone?'<div class="ph">'+esc(f.phone)+'</div>':''}</div>`;
    const noteBlock = (txt,label) => txt
      ? `<div class="note"><b>${label}</b>${esc(txt)}</div>` : '';

    const CANX = !!b.cancelled_at || b.status === 'cancelled';
    const canWhen = b.cancelled_at
      ? new Date(b.cancelled_at).toLocaleDateString('en-IN') + ' ' +
        new Date(b.cancelled_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})
      : '';

    return `
    <div class="lrdoc${CANX?' canx':''}">
      ${CANX?`<div class="canstamp"><span>CANCELLED</span></div>
        <div class="canbar">This consignment was cancelled${canWhen?' on '+canWhen:''}${
          b.cancel_reason?' \u2014 '+esc(b.cancel_reason):''}. It has not been carried.</div>`:''}
      <div class="lrtop">
        <div class="lrorg">
          <img class="logo" src="${N.LOGO}" alt="N2K Logistics">
          <div class="ln">Lorry Receipt &nbsp;/&nbsp; Consignment Note</div>
        </div>
        <div class="lrno">
          <span class="lbl">LR NUMBER</span>
          <div class="no">${b.booking_number}</div>
          <div class="bcbox">${N.barcodeSVG(b.booking_number,26)}</div>
          <div class="dt">${when.toLocaleDateString('en-IN')} &nbsp; ${when.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</div>
          <div class="cp">${copyLabel||''}</div>
        </div>
      </div>

      <div class="lrhubs">
        ${hubBlock(o,'BOOKING HUB')}
        ${hubBlock(d,'DESTINATION HUB')}
      </div>

      <div class="lrparties">
        <div><span class="h">CONSIGNOR</span>
          <div class="nm">${esc((b.customer&&b.customer.name)||'\u2014')}${conTown?', '+conTown:''}</div>
          ${(b.customer&&b.customer.contact_phone)?'<div class="ph">'+esc(b.customer.contact_phone)+'</div>':''}
          ${noteBlock(b.consignor_note,'NOTE')}</div>
        <div><span class="h">CONSIGNEE</span>
          <div class="nm">${esc(b.receiver_name||'\u2014')}${cneTown?', '+cneTown:''}</div>
          ${b.receiver_phone?'<div class="ph">'+esc(b.receiver_phone)+'</div>':''}
          ${noteBlock(b.consignee_note,'NOTE')}</div>
      </div>

      <table class="lrtbl"><thead><tr><th>#</th><th>Article</th><th class="r">Qty</th>
        <th class="r">Actual kg</th><th class="r">Billable</th><th>Basis</th>
        <th class="r">Rate</th><th class="r">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="2">TOTAL \u00b7 ${(b.lines||[]).length} line(s)</td>
          <td class="r qty">${T.qty}</td><td class="r">${T.awt?T.awt.toFixed(2).replace(/\.00$/,''):'\u2014'}</td>
          <td class="r">${T.bwt?T.bwt.toFixed(2).replace(/\.00$/,''):'\u2014'}</td>
          <td></td><td class="r">\u2014</td><td class="r">${rup(T.amt)}</td></tr></tfoot></table>

      ${invBlock}

      <div class="lrpay">
        <div>
          <span class="lbl">PAYMENT</span>
          <div class="pt">${payL}</div>
          <div class="dl">${({DD:'Door Delivery',OD:'Office Delivery',
            WD:'Office Delivery',ED:'Office Delivery',HC:'Office Delivery'})[b.delivery_type]||b.delivery_type||'\u2014'}</div>
        </div>
        <div class="amt"><span class="lbl">${isDue?'AMOUNT TO COLLECT':'GRAND TOTAL'}</span>
          <b>${rup(b.grand_total)}</b></div>
        <div class="brk">Freight ${rup(b.freight_total)} \u00b7 Loading ${rup(b.total_loading_charges)} \u00b7 Docket ${rup(b.docket_charges)}</div>
      </div>

      <div class="lrsign">
        <div class="terms"><b>Terms &amp; Conditions</b>
          <ol>
            <li>Parcel/Luggage are carried at owner\u2019s risk.</li>
            <li>In case the parcel is lost or damaged in transit, the company will not be liable,
              though every care shall be taken by the company for safe transportation of parcels.</li>
            <li>Liability of the company will be to the extent of Rs.100/- only.</li>
            <li>Contraband articles are not permitted to be carried in the vehicle. In case any
              objectionable/contraband goods are found in the packages on checkup by Octroi, Excise
              or any authority, their respective owners only shall be held responsible.</li>
            <li>We do not hold any other responsibility on arrival.</li>
            <li>Unloading charges to borne by receiving party.</li>
            <li>Parcel/Luggage should be collected within 24 hours of its arrival, failing which the
              management is not responsible for the delivery.</li>
          </ol></div>
        <div class="rcv"><span>RECEIVER SIGNATURE / SEAL &amp; DATE</span></div>
      </div>
    </div>`;
  };

  // Embedded so the LR prints identically offline and needs no image request.
  // The pin's solid red fill was removed and the numeral made solid instead:
  // same mark, a fraction of the ink.
  N.LOGO='data:image/png;base64,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';

  N.lrStyles=`
    /* GRID ONLY. Every background stays white so the printer lays down ink for
       the rules and the text and nothing else — no tinted headers, no shaded
       payment band, no red numerals. Emphasis comes from weight and size. */
    .lrdoc{border:1.2px solid #1B2340;font-family:Inter,Arial,sans-serif;color:#1B2340;background:#fff;
      display:flex;flex-direction:column}

    /* A cancelled LR has to be unmistakable: a copy is already in the customer's
       hands and must not pass at the destination as a live consignment. The
       stamp sits ACROSS the sheet rather than in a corner, so it cannot be
       trimmed off, and a plain line at the top states it in words for anyone
       reading a poor photocopy. */
    .lrdoc.canx{position:relative;border-color:#C0392B}
    .lrdoc.canx .canbar{background:#C0392B;color:#fff;font-size:9px;font-weight:800;
      letter-spacing:.05em;padding:4px 11px;text-align:center}
    .lrdoc.canx .canstamp{position:absolute;inset:0;display:flex;align-items:center;
      justify-content:center;pointer-events:none;z-index:5}
    .lrdoc.canx .canstamp span{border:3px solid #C0392B;color:#C0392B;font-family:Archivo,Arial,sans-serif;
      font-weight:900;font-size:34px;letter-spacing:.16em;padding:5px 26px;
      transform:rotate(-14deg);opacity:.32;white-space:nowrap}
    /* the sheet itself fades so the stamp reads over it without hiding the detail */
    .lrdoc.canx .lrtop,.lrdoc.canx .lrhubs,.lrdoc.canx .lrparties,
    .lrdoc.canx .lrtbl,.lrdoc.canx .lrinv,.lrdoc.canx .lrpay{opacity:.55}
    .lrdoc > .lrsign{flex:1 1 auto}

    .lrtop{display:flex;justify-content:space-between;align-items:flex-start;
      padding:7px 11px;border-bottom:1.2px solid #1B2340}
    /* the logo already says the company name, so no wordmark beside it */
    .lrorg{display:flex;flex-direction:column;align-items:flex-start;gap:3px}
    .lrorg .logo{height:46px;width:auto;display:block}
    .lrorg .ln{font-size:10px;color:#555;font-weight:600;letter-spacing:.11em;
      text-transform:uppercase;padding-left:2px}
    .lrno{text-align:right;line-height:1.05}
    .lrno .lbl{font-size:7.5px;letter-spacing:.1em;color:#555;font-weight:700;display:block}
    .lrno .no{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:23px;letter-spacing:-.4px}
    .lrno .bcbox{margin-top:3px}
    .lrno .bcbox svg{width:150px;height:24px}
    .lrno .dt{font-size:10px;font-weight:700;margin-top:2px}
    .lrno .cp{font-size:7.5px;letter-spacing:.09em;color:#555;font-weight:700;margin-top:1px}

    .lrhubs{display:grid;grid-template-columns:1fr 1fr;border-bottom:1.2px solid #1B2340;font-size:10.5px}
    .lrhubs>div{padding:6px 11px}
    .lrhubs>div:first-child{border-right:1px solid #B9C0D0}
    .lrhubs .h{display:block;font-size:7.5px;letter-spacing:.09em;font-weight:800;color:#555}
    .lrhubs .nm{font-weight:800;font-size:12px;margin-top:1px;text-transform:uppercase;letter-spacing:.02em}
    .lrhubs .ad{color:#333;margin-top:1px;line-height:1.35}
    .lrhubs .ph{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:11.5px;color:#1B2340}

    .lrparties{display:grid;grid-template-columns:1fr 1fr;border-bottom:1.2px solid #1B2340;font-size:10.5px}
    .lrparties>div{padding:7px 11px}
    .lrparties>div:first-child{border-right:1px solid #B9C0D0}
    .lrparties .h{display:block;font-size:7.5px;letter-spacing:.09em;font-weight:800;color:#555}
    /* uppercase in CSS only: the database keeps the name exactly as typed, so
       search and customer matching are unaffected and reprints match too */
    .lrparties .nm{font-size:15px;font-weight:800;line-height:1.2;margin-top:1px;
      text-transform:uppercase;letter-spacing:.01em}
    .lrparties .ph{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:13px;
      margin-top:2px;letter-spacing:.02em}
    .lrparties .note{margin-top:3px;padding-top:3px;border-top:1px dotted #B9C0D0;font-size:10px;color:#333}
    .lrparties .note b{font-size:7.5px;letter-spacing:.08em;color:#555;display:block;font-weight:800}

    table.lrtbl{width:100%;border-collapse:collapse;font-size:11.5px}
    .lrtbl th{font-size:8px;letter-spacing:.05em;text-transform:uppercase;color:#555;text-align:left;
      padding:4px 8px;border-bottom:1px solid #1B2340;font-weight:800}
    .lrtbl td{padding:5px 8px;border-bottom:1px solid #D5DAE5}
    .lrtbl .r{text-align:right}
    .lrtbl tfoot td{border-top:1.2px solid #1B2340;border-bottom:1.2px solid #1B2340;
      font-weight:800;font-size:11.5px}
    .lrtbl tfoot td.qty{font-size:15px;font-weight:900}

    /* invoice and e-way sit BELOW the articles */
    .lrinv{border-bottom:1.2px solid #1B2340}
    .lrinv table{width:100%;border-collapse:collapse;font-size:10.5px}
    .lrinv th{font-size:8px;letter-spacing:.05em;text-transform:uppercase;color:#555;text-align:left;
      padding:4px 8px;font-weight:800;border-bottom:1px solid #D5DAE5}
    .lrinv td{padding:4px 8px;border-bottom:1px solid #D5DAE5}
    .lrinv tr:last-child td{border-bottom:0}
    .lrinv .r{text-align:right}
    .lrinv .ewb{font-family:'IBM Plex Mono',monospace}
    .lrinv tr.it td{font-weight:800}
    .lrinv.one{padding:5px 11px;font-size:10.5px}

    /* delivery type sits under the payment type */
    .lrpay{display:grid;grid-template-columns:1fr auto;gap:8px;padding:7px 11px;
      border-bottom:1.2px solid #1B2340;align-items:end}
    .lrpay .lbl{font-size:7.5px;letter-spacing:.09em;color:#555;font-weight:800;display:block}
    .lrpay .pt{font-family:Archivo,Arial,sans-serif;font-weight:900;font-size:19px;line-height:1.1}
    .lrpay .dl{font-size:11.5px;font-weight:700;margin-top:2px}
    .lrpay .amt{text-align:right}
    .lrpay .amt b{font-family:Archivo,Arial,sans-serif;font-weight:900;font-size:23px;line-height:1.1;display:block}
    .lrpay .brk{grid-column:1/-1;font-size:9.5px;color:#555;border-top:1px dotted #B9C0D0;padding-top:3px}

    .lrsign{display:grid;grid-template-columns:1.5fr 1fr;font-size:9px;color:#333}
    .lrsign>div{padding:6px 11px}
    .lrsign .rcv{border-left:1px solid #B9C0D0;text-align:center;padding-top:22px;
      font-size:7.5px;letter-spacing:.08em;color:#555;font-weight:800}
    /* seven clauses have to fit while two copies share one A4, so this is
       deliberately the smallest type on the sheet; it reads fine in print */
    .lrsign .terms{line-height:1.35;font-size:6.8px}
    .lrsign .terms b{font-size:8px;display:block;margin-bottom:2px;letter-spacing:.03em}
    .lrsign .terms ol{margin:0;padding-left:11px}
    .lrsign .terms li{margin-bottom:1px}
  `;

  // full printable page: TWO copies on one A4 sheet
  N.lrHtml=function(b){
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${b.booking_number}</title>
      <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800;900&family=Inter:wght@400;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
      <style>
        @page{size:A4 portrait;margin:7mm}
        body{margin:0;font-family:Inter,Arial,sans-serif;
          -webkit-print-color-adjust:exact;print-color-adjust:exact}
        ${N.lrStyles}
        .sheet{display:flex;flex-direction:column;gap:5mm}
                .copy{height:135mm;overflow:hidden;box-sizing:border-box;page-break-inside:avoid}
        .copy > .lrdoc{height:100%;box-sizing:border-box}
        .cut{border-top:1px dashed #9AA3B5;position:relative;height:0}
        .cut span{position:absolute;left:50%;top:-7px;transform:translateX(-50%);background:#fff;
          padding:0 8px;font-size:8px;color:#9AA3B5;letter-spacing:.1em}
        .lrdoc{page-break-inside:avoid}
        html,body{height:auto}
        .sheet{page-break-after:avoid}
        .sheet>*:last-child{page-break-after:avoid}
      </style></head>
      <script>
        // Each copy takes exactly half the printable page: short ones stretch
        // (the extra room goes to the signature box), long ones scale down to fit.
        function fitCopies(){
          var frames=document.querySelectorAll('.copy');
          for(var i=0;i<frames.length;i++){
            var f=frames[i], d=f.firstElementChild;
            d.style.transform=''; d.style.width=''; d.style.height='auto';
            var natural=d.getBoundingClientRect().height;
            var box=f.getBoundingClientRect().height;
            if(natural>box){                       // long consignment -> scale to fit
              var s=box/natural;
              d.style.transformOrigin='top left';
              d.style.transform='scale('+s+')';
              d.style.width=(100/s)+'%';
            }else{                                 // short -> stretch, extra room to the sign box
              d.style.height='100%';
            }
          }
        }
      </script>
      <body onload="fitCopies();window.print()">
        <div class="sheet">
          <div class="copy">${N.lrDoc(b,'CONSIGNOR COPY')}</div>
          <div class="cut"><span>\u2702 CUT HERE</span></div>
          <div class="copy">${N.lrDoc(b,'CONSIGNEE COPY')}</div>
        </div>
      </body></html>`;
  };

  // fetch everything the LR needs for one booking
  N.lrData=async function(bookingId){
    const d=ok(await sb.from('bookings').select(
      '*,origin:origin_facility_id(code,name,phone,email,address),'+
      'dest:destination_facility_id(code,name,phone,email,address),'+
      'customer:customer_id(name,contact_phone,gstin),'+
      'lines:booking_lines(quantity,uom,actual_weight_kg,billable_weight,freight_per_qty,freight_total,freight_basis,description,'+
      'article:article_id(name))').eq('id',bookingId).limit(1));
    if(!d.length) throw new Error('booking not found');
    const b=d[0];
    try{ b.invoices=await N.invoicesFor(bookingId); }catch(e){ b.invoices=[]; }
    return b;
  };

  N.printLR=async function(bookingId){
    const b=await N.lrData(bookingId);
    const w=window.open('','_blank','width=900,height=1000');
    if(!w) throw new Error('Pop-up blocked — allow pop-ups to print the LR');
    w.document.write(N.lrHtml(b)); w.document.close();
    return true;
  };
})();


/* ---- reporting over any date range ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const from0=d=>new Date(d+'T00:00:00').toISOString();
  const to24=d=>new Date(d+'T23:59:59.999').toISOString();

  // branch-wise consolidated figures for a date range
  N.rangeSummary=async function(from,to,branchCode){
    const F=await N.facilities();
    const branches=F.list.filter(f=>f.kind!=='line');
    const byId={}; branches.forEach(f=>byId[f.id]=f.code);
    const only=branchCode||null;
    let q=sb.from('bookings').select(
      'id,status,created_at,total_pieces,grand_total,payment_type,origin_facility_id,destination_facility_id').is('cancelled_at',null)
      .gte('created_at',from0(from)).lte('created_at',to24(to)).limit(10000);
    if(only){ const f=F.byCode[only]; if(f) q=q.eq('origin_facility_id',f.id); }
    const bk=ok(await q);
    const ids=bk.map(b=>b.id);
    let deliveredIds=new Set();
    if(ids.length){
      // delivered inside the same window (by scan time, not booking date)
      const it=ok(await sb.from('consignment_items').select('booking_id,delivered_at')
        .gte('delivered_at',from0(from)).lte('delivered_at',to24(to)).limit(20000));
      const set=new Set(ids);
      it.forEach(i=>{ if(set.has(i.booking_id)) deliveredIds.add(i.booking_id); });
    }
    const m={};
    const row=c=>m[c]||(m[c]={code:c,name:(F.byCode[c]&&F.byCode[c].name)||c,
      bookings:0,pieces:0,value:0,delivered:0,pending:0,failed:0,toCollect:0});
    bk.forEach(b=>{
      const c=byId[b.origin_facility_id]; if(!c) return;
      const r=row(c);
      r.bookings++; r.pieces+=b.total_pieces||0; r.value+=parseFloat(b.grand_total)||0;
      if(deliveredIds.has(b.id)) r.delivered++;
      else if(b.status==='delivery_failed') r.failed++;
      else if(b.status!=='delivered'&&b.status!=='returned') r.pending++;
      if(b.payment_type==='to_pay'&&b.status!=='delivered')
        r.toCollect+=parseFloat(b.grand_total)||0;
    });
    return Object.values(m).sort((a,b)=>a.name.localeCompare(b.name));
  };

  // TRIP SHEET for a range: every trip with crew, KM, diesel and its LR count
  N.tripSheetRange=async function(from,to,branchCode){
    const F=await N.facilities();
    let q=sb.from('trips').select(
      'id,trip_number,status,created_at,departed_at,arrived_at,open_km,close_km,diesel_litres,'+
      'origin:origin_facility_id(code,name),dest:destination_facility_id(code,name),'+
      'vehicle:vehicle_id(label,registration),driver:driver_id(user:user_id(full_name)),helper:helper_id(full_name)')
      .gte('created_at',from0(from)).lte('created_at',to24(to))
      .order('created_at',{ascending:false}).limit(2000);
    if(branchCode){ const f=F.byCode[branchCode];
      if(f) q=q.or('origin_facility_id.eq.'+f.id+',destination_facility_id.eq.'+f.id); }
    const trips=ok(await q);
    if(trips.length){
      const ti=ok(await sb.from('trip_items').select('trip_id,item_id')
        .in('trip_id',trips.map(t=>t.id)).limit(20000));
      const cnt={}; ti.forEach(x=>cnt[x.trip_id]=(cnt[x.trip_id]||0)+1);
      trips.forEach(t=>{ t.pieces=cnt[t.id]||0;
        t.run_km=(t.close_km!=null&&t.open_km!=null&&t.close_km>=t.open_km)?t.close_km-t.open_km:null;
        t.kmpl=(t.run_km&&t.diesel_litres)?(t.run_km/parseFloat(t.diesel_litres)).toFixed(1):null; });
    }
    return trips;
  };

  // the LRs carried on one trip (for the trip-sheet drill-down)
  N.tripLRs=async function(tripId){
    const rows=ok(await sb.from('trip_manifest').select('*').eq('trip_id',tripId));
    const seen={}; const out=[];
    rows.forEach(r=>{ if(seen[r.booking_id])
      { seen[r.booking_id].pieces++; return; }
      seen[r.booking_id]={booking_id:r.booking_id,booking_number:r.booking_number,
        receiver_name:r.receiver_name,payment_type:r.payment_type,grand_total:r.grand_total,
        current_status:r.current_status,pieces:1};
      out.push(seen[r.booking_id]); });
    return out;
  };

  // ACCOUNT SHEET for a range, straight from the database view
  N.accountSheetRange=async function(from,to,branchCode){
    let q=sb.from('account_sheet').select('*')
      .gte('close_date',from).lte('close_date',to).order('close_date',{ascending:false});
    if(branchCode) q=q.eq('branch_code',branchCode);
    return ok(await q);
  };

  // day-close submission status across a range
  N.dayCloseRange=async function(from,to){
    return ok(await sb.from('branch_day_close')
      .select('close_date,status,submitted_at,facility:facility_id(code,name)')
      .gte('close_date',from).lte('close_date',to).order('close_date',{ascending:false}));
  };

  // CSV download for any table on screen
  N.downloadCSV=function(filename,headers,rows){
    const esc=v=>{const s=(v==null?'':String(v)).replace(/"/g,'""');
      return /[",\n]/.test(s)?'"'+s+'"':s;};
    const csv=[headers.map(esc).join(',')].concat(rows.map(r=>r.map(esc).join(','))).join('\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=filename;
    document.body.appendChild(a); a.click(); a.remove();
  };
})();

/* ---- live push: react to database changes instead of only polling ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  // cb(table) fires on any insert/update/delete in the listed tables
  N.subscribe=function(tables,cb){
    if(!sb||!sb.channel) return null;
    try{
      let ch=sb.channel('n2k-'+Math.random().toString(36).slice(2,8));
      tables.forEach(t=>{
        ch=ch.on('postgres_changes',{event:'*',schema:'public',table:t},p=>{
          try{ cb(t,p); }catch(e){}
        });
      });
      ch.subscribe();
      return ch;
    }catch(e){ console.warn('realtime unavailable:',e.message); return null; }
  };
})();

/* ---- v6: drop points, invoices, freight basis, road map ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};

  // drop points for a destination facility (booking screen)
  N.dropPoints=async function(destCode){
    if(!destCode) return [];
    const F=await N.facilities();
    const f=F.byCode[destCode];
    if(!f) return [];
    // a hub's drop points live on its lines, so gather those too
    const ids=[f.id].concat(F.list.filter(x=>x.parent_facility_id===f.id).map(x=>x.id));
    const d=ok(await sb.from('drop_points')
      .select('id,name,landmark,seq,facility_id,line:facility_id(code,name,kind)')
      .in('facility_id',ids).eq('is_active',true).order('seq').order('name'));
    return d.map(x=>({id:x.id,name:x.name,landmark:x.landmark,seq:x.seq,
      line:(x.line&&x.line.kind==='line')?(x.line.name):null,
      lineCode:(x.line&&x.line.kind==='line')?(x.line.code):null}));
  };

  // masters tab
  N.masters.loadDropPoints=async function(){
    const d=ok(await sb.from('drop_points')
      .select('id,name,landmark,seq,is_active,facility:facility_id(code,name)').order('seq').order('name'));
    return d.map(x=>({_id:x.id,name:x.name,landmark:x.landmark||'',seq:x.seq,
      branch:x.facility?x.facility.code:'',active:x.is_active}));
  };
  N.masters.saveDropPoint=async function(v,id){
    const F=await N.facilities(true);
    const code=String(v.branch||'').split('—')[0].trim();
    const f=F.byCode[code]||F.list.find(x=>x.code.toLowerCase()===code.toLowerCase());
    if(!f) throw new Error('Choose the branch or line this drop point belongs to');
    const body={facility_id:f.id,name:v.name,landmark:v.landmark||null,seq:parseInt(v.seq,10)||0};
    if(id) ok(await sb.from('drop_points').update(body).eq('id',id));
    else ok(await sb.from('drop_points').insert(Object.assign(body,{is_active:true})));
  };

  // invoices attached to a booking
  N.saveInvoices=async function(bookingId,rows){
    const clean=(rows||[]).filter(r=>r.invoice_no||r.eway_bill_number||r.invoice_value);
    if(!clean.length) return 0;
    ok(await sb.from('booking_invoices').insert(clean.map(r=>({
      booking_id:bookingId, invoice_no:r.invoice_no||null,
      invoice_date:r.invoice_date||null,
      invoice_value:r.invoice_value||null, gst_value:r.gst_value||null,
      eway_bill_number:r.eway_bill_number||null}))));
    return clean.length;
  };
  N.invoicesFor=async function(bookingId){
    return ok(await sb.from('booking_invoices').select('*').eq('booking_id',bookingId).order('created_at'));
  };

  // ---- Road Map: today's deliveries grouped by drop point ----
  // mode 'line'  -> one section per destination line/branch
  // mode 'trip'  -> one section per loaded vehicle
  /* checkLeftovers() and loadLines() both need this same data at the same
     moment on page load — one via linesWithCargo, one via notOnAnyRun —
     and previously each triggered its own full network round trip to a
     view with several joins and a per-row subquery, running twice,
     simultaneously, on every visit to this page. This only dedupes calls
     that are genuinely in flight at the same time — nothing is cached
     after it resolves, so there's no staleness risk, just no more paying
     for the same query twice in the same breath. */
  const _rmInflight={};
  N.roadMap=async function(branchCode,date,mode){
    const key=branchCode+'|'+(date||'')+'|'+(mode||'');
    if(_rmInflight[key]) return _rmInflight[key];
    const p=(async()=>{
      const F=await N.facilities();
      const f=F.byCode[branchCode];
      if(!f) throw new Error('branch not found');
      const day=date||n2kTodayLocal();
      const mine=F.list.filter(x=>x.id===f.id||x.parent_facility_id===f.id).map(x=>x.id);
      const OPEN=['booked','received_at_origin','sorted','loaded','departed','in_transit',
                  'arrived_at_hub','arrived_at_destination','out_for_delivery','delivery_failed'];
      let rows=ok(await sb.from('road_map').select('*')
        .in('dest_id',mine).in('status',OPEN).order('drop_seq').order('booking_number'));

      const groups={};
      rows.forEach(r=>{
        const key = r.line_name || r.dest_name || r.dest_code || '\u2014';
        groups[key]=groups[key]||{key,meta:(r.line_code || r.dest_code || ''),
          stops:{}, lrs:0, pieces:0, collect:0};
        const g=groups[key];
        const stop=r.drop_point||'(no drop point)';
        g.stops[stop]=g.stops[stop]||{name:stop,seq:r.drop_seq,landmark:r.drop_landmark,items:[]};
        g.stops[stop].items.push(r);
        g.lrs++; g.pieces+=r.total_pieces||0;
        if(r.payment_type==='to_pay'&&r.status!=='delivered') g.collect+=parseFloat(r.grand_total)||0;
      });
      return {date:day, mode:mode||'line',
        groups:Object.values(groups).map(g=>({...g,
          stops:Object.values(g.stops).sort((a,b)=>(a.seq-b.seq)||a.name.localeCompare(b.name))}))
          .sort((a,b)=>a.key.localeCompare(b.key))};
    })();
    _rmInflight[key]=p;
    try{ return await p; } finally { delete _rmInflight[key]; }
  };
})();

/* ---- day run: vehicle + crew captured on the Road Map (replaces Loading) ---- */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const dayStart=()=>{const t=new Date();t.setHours(0,0,0,0);return t.toISOString();};

  // the run (trip) for one destination today, if it exists
  N.runFor=async function(branchCode,destCode){
    const F=await N.facilities();
    const o=F.byCode[branchCode], d=F.byCode[destCode];
    if(!o||!d) return null;
    const t=ok(await sb.from('trips').select(
      'id,trip_number,status,open_km,close_km,diesel_litres,vehicle_id,driver_id,helper_id')
      .eq('origin_facility_id',o.id).eq('destination_facility_id',d.id)
      .gte('created_at',dayStart()).order('created_at',{ascending:false}).limit(1));
    return t.length?t[0]:null;
  };

  // create or update the run, and attach the day's consignments to it
  N.saveRun=async function(p){
    const F=await N.facilities();
    const o=F.byCode[p.branchCode], d=F.byCode[p.destCode];
    if(!o||!d) throw new Error('facility not found');
    let run=await N.runFor(p.branchCode,p.destCode);
    const body={vehicle_id:p.vehicleId||null, driver_id:p.driverId||null, helper_id:p.helperId||null,
      open_km:p.openKm!=null?p.openKm:null, close_km:p.closeKm!=null?p.closeKm:null,
      diesel_litres:p.diesel!=null?p.diesel:null};
    if(p.closeKm!=null && p.openKm!=null && p.closeKm < p.openKm)
      throw new Error('Closing KM ('+p.closeKm+') cannot be less than opening KM ('+p.openKm+')');
    if(run){ ok(await sb.from('trips').update(body).eq('id',run.id)); }
    else{
      const no=ok(await sb.rpc('next_trip_no',{p_branch:p.branchCode}));
      run=ok(await sb.from('trips').insert(Object.assign({trip_number:no,
        origin_facility_id:o.id, destination_facility_id:d.id, status:'departed',
        departed_at:new Date().toISOString()},body)).select('id,trip_number'))[0];
    }
    // attach today's undelivered consignments for this destination to the run
    if(p.bookingIds&&p.bookingIds.length){
      const items=ok(await sb.from('consignment_items').select('id,booking_id').in('booking_id',p.bookingIds));
      const have=ok(await sb.from('trip_items').select('item_id').eq('trip_id',run.id));
      const has=new Set(have.map(x=>x.item_id));
      const add=items.filter(i=>!has.has(i.id));
      if(add.length) await sb.from('trip_items').insert(add.map(i=>({trip_id:run.id,item_id:i.id})));
    }
    return run;
  };
})();

/* ---- shared: human-readable age ---- */
(function(){
  const N=window.N2K;
  N.ageText=function(ms){
    if(!ms||ms<0) return '\u2014';
    const h=Math.floor(ms/3600000), d=Math.floor(h/24);
    if(d>0) return d+'d '+(h%24)+'h';
    if(h>0) return h+'h '+Math.floor((ms%3600000)/60000)+'m';
    return Math.max(1,Math.floor(ms/60000))+'m';
  };
})();

/* ---- bulk import: hubs, lines, drop points ---- */
(function(){
  const N=window.N2K;
  const db=()=>N.sb;   // resolved at call time, not at load
  const ok=r=>{if(r.error)throw r.error;return r.data;};

  N.csvParse=function(text){
    const rows=[]; let row=[], cell='', q=false;
    text=String(text||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(q){
        if(c==='"'){ if(text[i+1]==='"'){cell+='"';i++;} else q=false; }
        else cell+=c;
      }else{
        if(c==='"') q=true;
        else if(c===','||c==='\t'){ row.push(cell); cell=''; }
        else if(c==='\n'){ row.push(cell); rows.push(row); row=[]; cell=''; }
        else cell+=c;
      }
    }
    if(cell!==''||row.length){ row.push(cell); rows.push(row); }
    return rows.filter(r=>r.some(x=>String(x).trim()!==''))
               .map(r=>r.map(x=>String(x).trim()));
  };

  N.importSpecs={
    hubs:{title:'Hubs / branches', cols:['code','name','city','phone','email','address'],
      required:['code','name'],
      sample:'code,name,city,phone,email,address\nNMB01,Nambiyur,Nambiyur,04285 267011,nambiyur@n2klogistics.in,"Main Road, Nambiyur - 638458"'},
    lines:{title:'Lines', cols:['code','name','hub_code','city'],
      required:['code','name','hub_code'],
      sample:'code,name,hub_code,city\nATRL,Anthiyur Line,NMB01,Anthiyur'},
    drops:{title:'Drop points', cols:['line_code','name','landmark','seq'],
      required:['line_code','name'],
      sample:'line_code,name,landmark,seq\nATRL,Anthiyur bus stand,near clock tower,1'},
    customers:{title:'Customers', cols:['name','phone','kind','gstin','email','address'],
      required:['name','phone'],
      sample:'name,phone,kind,gstin,email,address\nPalani Agro Service,9000000001,company,33AABCU9603R1ZM,palani@example.com,"55 Main Road, Nambiyur - 638458"'}
  };

  // turn raw CSV rows into checked records (no writes yet)
  N.importPreview=async function(kind,rows){
    const spec=N.importSpecs[kind];
    if(!rows.length) throw new Error('Nothing to import');
    let head=rows[0].map(h=>h.toLowerCase().replace(/\s+/g,'_'));
    let body=rows.slice(1);
    if(!spec.required.every(c=>head.includes(c))){        // no header row? assume column order
      head=spec.cols.slice(); body=rows;
    }
    const F=await N.facilities(true);
    const all=ok(await db().from('facilities').select('id,code,name,kind,parent_facility_id'));
    const byCode={}; all.forEach(f=>byCode[f.code.toUpperCase()]=f);
    let drops=[];
    if(kind==='drops') drops=ok(await db().from('drop_points').select('id,name,facility_id'));
    return body.map((r,i)=>{
      const o={}; head.forEach((h,j)=>o[h]=(r[j]||'').trim());
      const rec={line:i+1, data:o, action:'create', error:null};
      if(kind==='drops'){
        const lc=(o.line_code||'').toUpperCase();
        const parent=byCode[lc];
        if(!o.name) rec.error='drop point name is empty';
        else if(!lc) rec.error='line_code is empty';
        else if(!parent) rec.error='line "'+lc+'" not found — add the line first';
        else{
          rec.facility_id=parent.id;
          const dup=drops.find(d=>d.facility_id===parent.id &&
            d.name.toLowerCase()===o.name.toLowerCase());
          if(dup){ rec.action='update'; rec.id=dup.id; }
        }
      }else{
        const code=(o.code||'').toUpperCase();
        if(!code) rec.error='code is empty';
        else if(!o.name) rec.error='name is empty';
        else if(kind==='lines'){
          const hub=byCode[(o.hub_code||'').toUpperCase()];
          if(!o.hub_code) rec.error='hub_code is empty';
          else if(!hub) rec.error='hub "'+o.hub_code+'" not found — add the hub first';
          else rec.parent=hub.id;
        }
        if(!rec.error && byCode[code]){ rec.action='update'; rec.id=byCode[code].id; }
      }
      return rec;
    });
  };

  // write the checked records
  N.importCommit=async function(kind,recs){
    const good=recs.filter(r=>!r.error);
    let created=0, updated=0;
    for(const r of good){
      const o=r.data;
      if(kind==='drops'){
        const body={facility_id:r.facility_id, name:o.name, landmark:o.landmark||null,
          seq:parseInt(o.seq,10)||0};
        if(r.action==='update') ok(await db().from('drop_points').update(body).eq('id',r.id));
        else ok(await db().from('drop_points').insert(Object.assign(body,{is_active:true})));
      }else{
        const body={code:(o.code||'').toUpperCase(), name:o.name, city:o.city||null,
          kind: kind==='lines'?'line':'branch'};
        if(kind==='lines') body.parent_facility_id=r.parent;
        else { body.phone=o.phone||null; body.email=o.email||null; body.address=o.address||null; }
        if(r.action==='update') ok(await db().from('facilities').update(body).eq('id',r.id));
        else ok(await db().from('facilities').insert(Object.assign(body,{is_active:true,
          can_book:kind!=='lines', can_deliver:true})));
      }
      r.action==='update'?updated++:created++;
    }
    await N.facilities(true);
    return {created,updated,skipped:recs.length-good.length};
  };
})();

/* ---- masters v2: explicit hierarchy  user -> hub -> line -> drop point ---- */
(function(){
  const N=window.N2K;
  const db=()=>N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const HUB_KINDS=['branch','hub'];

  // resolve "CODE - Name" or "CODE" to a facility id of the expected kind
  async function facId(label,kinds){
    if(!label) return null;
    const c=String(label).split('\u2014')[0].trim();
    if(!c || c.toLowerCase().indexOf('(no')===0) return null;
    const F=await N.facilities(true);
    const hit=F.list.find(f=>f.code.toLowerCase()===c.toLowerCase()
      && (!kinds || kinds.indexOf(f.kind)>=0));
    if(!hit) throw new Error('"'+c+'" is not a valid '+((kinds&&kinds.indexOf('line')>=0)?'line':'hub'));
    return hit.id;
  }
  N.facIdFor=facId;

  N.hubOptions=async function(fresh){
    const F=await N.facilities(!!fresh);
    return F.list.filter(f=>HUB_KINDS.indexOf(f.kind)>=0).map(f=>f.code+' \u2014 '+f.name);
  };
  N.lineOptions=async function(fresh){
    const F=await N.facilities(!!fresh);
    return F.list.filter(f=>f.kind==='line').map(f=>f.code+' \u2014 '+f.name);
  };

  /* ---- HUBS ---- */
  N.masters.loadHubs=async function(){
    const d=ok(await db().from('facilities')
      .select('id,code,name,kind,city,phone,email,address,is_active')
      .in('kind',HUB_KINDS).order('name'));
    let cnt={};
    try{
      const lines=ok(await db().from('facilities').select('parent_facility_id').eq('kind','line'));
      lines.forEach(l=>{ if(l.parent_facility_id) cnt[l.parent_facility_id]=(cnt[l.parent_facility_id]||0)+1; });
    }catch(e){}
    return d.map(f=>({_id:f.id,code:f.code,name:f.name,city:f.city||'',phone:f.phone||'',
      email:f.email||'',address:f.address||'',lines:cnt[f.id]||0,active:f.is_active}));
  };
  N.masters.saveHub=async function(v,id){
    const code=(v.code||'').toUpperCase().trim();
    if(!code) throw new Error('Hub code is required');
    const body={code:code,name:v.name,kind:'hub',city:v.city||null,
      phone:v.phone||null,email:v.email||null,address:v.address||null};
    if(id) ok(await db().from('facilities').update(body).eq('id',id));
    else ok(await db().from('facilities').insert(Object.assign(body,
      {is_active:true,can_book:true,can_deliver:true})));
    await N.facilities(true);
  };

  /* ---- LINES (belong to a hub) ---- */
  N.masters.loadLines=async function(){
    const d=ok(await db().from('facilities')
      .select('id,code,name,city,is_active,parent_facility_id,hub:parent_facility_id(code,name)')
      .eq('kind','line').order('name'));
    let cnt={};
    try{
      const dps=ok(await db().from('drop_points').select('facility_id').eq('is_active',true));
      dps.forEach(x=>{cnt[x.facility_id]=(cnt[x.facility_id]||0)+1;});
    }catch(e){}
    return d.map(f=>({_id:f.id,code:f.code,name:f.name,city:f.city||'',
      hub:f.hub?(f.hub.code+' \u2014 '+f.hub.name):'',
      drops:cnt[f.id]||0,active:f.is_active}));
  };
  N.masters.saveLine=async function(v,id){
    const hub=await facId(v.hub,HUB_KINDS);
    if(!hub) throw new Error('Choose the hub this line belongs to');
    const code=(v.code||'').toUpperCase().trim();
    if(!code) throw new Error('Line code is required');
    const body={code:code,name:v.name,kind:'line',city:v.city||null,parent_facility_id:hub};
    if(id) ok(await db().from('facilities').update(body).eq('id',id));
    else ok(await db().from('facilities').insert(Object.assign(body,
      {is_active:true,can_book:false,can_deliver:true})));
    await N.facilities(true);
  };

  /* ---- DROP POINTS (belong to a line) ---- */
  N.masters.loadDropPoints=async function(){
    const d=ok(await db().from('drop_points')
      .select('id,name,landmark,seq,is_active,line:facility_id(code,name,hub:parent_facility_id(code))')
      .order('seq').order('name'));
    return d.map(x=>({_id:x.id,name:x.name,landmark:x.landmark||'',seq:x.seq,
      line:x.line?(x.line.code+' \u2014 '+x.line.name):'',
      hub:(x.line&&x.line.hub)?x.line.hub.code:'',
      active:x.is_active}));
  };
  N.masters.saveDropPoint=async function(v,id){
    const line=await facId(v.line,['line']);
    if(!line) throw new Error('Choose the line this drop point belongs to');
    if(!v.name) throw new Error('Drop point name is required');
    const body={facility_id:line,name:v.name,landmark:v.landmark||null,seq:parseInt(v.seq,10)||0};
    if(id) ok(await db().from('drop_points').update(body).eq('id',id));
    else ok(await db().from('drop_points').insert(Object.assign(body,{is_active:true})));
  };

  /* users map to a HUB - validate before writing */
  N.masters.saveUser=(function(orig){
    return async function(v,id){
      if(v.branch) await facId(v.branch,HUB_KINDS);
      return orig(v,id);
    };
  })(N.masters.saveUser);
})();

/* ---- runs: staff-built delivery route (Road Map) ---- */
(function(){
  const N=window.N2K;
  const db=()=>N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const dayStart=d=>{const t=d?new Date(d+'T00:00:00'):new Date();t.setHours(0,0,0,0);return t.toISOString();};
  const dayEnd=d=>{const t=d?new Date(d+'T23:59:59'):new Date();t.setHours(23,59,59,999);return t.toISOString();};

  // lines under this branch that have cargo waiting today
  N.linesWithCargo=async function(branchCode,date){
    const rm=await N.roadMap(branchCode,date,'line');
    const F=await N.facilities();
    return rm.groups.map(g=>{
      const f=F.list.find(x=>x.code===g.meta) || null;
      return {code:g.meta||'', name:g.key, id:f?f.id:null,
              lrs:g.lrs, pieces:g.pieces, collect:g.collect,
              stops:g.stops.map(s=>({name:s.name,seq:s.seq,landmark:s.landmark,
                                     dropId:(s.items[0]&&s.items[0].drop_point_id)||null,
                                     lineCode:g.meta||'', items:s.items}))};
    });
  };

  // today's runs for a branch
  N.runsFor=async function(branchCode,date){
    const F=await N.facilities(); const f=F.byCode[branchCode];
    if(!f) return [];
    return ok(await db().from('run_summary').select('*')
      .eq('origin_code',branchCode)
      .eq('run_date',(date||n2kTodayLocal()))
      .order('trip_number'));
  };

  // create a run: vehicle + crew + opening KM, the lines it covers,
  // and the stop list in the order staff arranged
  N.createRun=async function(p){
    const F=await N.facilities();
    const o=F.byCode[p.branchCode];
    if(!o) throw new Error('branch not found');
    if(!p.vehicleId) throw new Error('Choose the vehicle');
    if(!p.driverId)  throw new Error('Choose the driver');
    if(!p.lineIds||!p.lineIds.length) throw new Error('Tick at least one line for this run');
    const dest=p.lineIds[0];
    const no=ok(await db().rpc('next_trip_no',{p_branch:p.branchCode}));
    // who is building this run
    let by=null;
    const me=N.session.get();
    if(me&&me.phone){
      try{ const u=ok(await db().from('users').select('id').eq('phone',me.phone).limit(1));
        if(u.length) by=u[0].id; }catch(e){}
    }
    const trip=ok(await db().from('trips').insert({
      trip_number:no, origin_facility_id:o.id, destination_facility_id:dest,
      vehicle_id:p.vehicleId, driver_id:p.driverId, helper_id:p.helperId||null,
      open_km:(p.openKm!=null?p.openKm:null), created_by:by,
      status:'departed', departed_at:new Date().toISOString()
    }).select('id,trip_number'))[0];

    ok(await db().from('trip_lines').insert(
      p.lineIds.map((id,i)=>({trip_id:trip.id,facility_id:id,seq:i+1}))));

    if(p.stops&&p.stops.length)
      ok(await db().from('trip_stops').insert(p.stops.map((s,i)=>({
        trip_id:trip.id, drop_point_id:s.dropId||null, stop_name:s.name,
        line_code:s.lineCode||null, seq:i+1}))));

    // per-LR order within the run — continuous across every stop, so a
    // stop with two consignees still has a first and a second. Falls back
    // gracefully if not supplied: the sheet then just falls back to
    // booking_number order (see runSheet).
    if(p.bookingSeq&&p.bookingSeq.length)
      ok(await db().from('trip_booking_seq').insert(p.bookingSeq.map(x=>({
        trip_id:trip.id, booking_id:x.bookingId, seq:x.seq}))));

    // attach the consignments so the Trip Sheet and Account Sheet see them
    if(p.bookingIds&&p.bookingIds.length){
      const items=ok(await db().from('consignment_items').select('id').in('booking_id',p.bookingIds));
      if(items.length) await db().from('trip_items')
        .insert(items.map(i=>({trip_id:trip.id,item_id:i.id})));
    }
    return trip;
  };

  // save a new stop order for an existing run, and optionally a new
  // per-LR order alongside it (see createRun for why the two are separate)
  N.saveRunOrder=async function(tripId,stops,bookingSeq){
    await db().from('trip_stops').delete().eq('trip_id',tripId);
    if(stops&&stops.length)
      ok(await db().from('trip_stops').insert(stops.map((s,i)=>({
        trip_id:tripId, drop_point_id:s.dropId||null, stop_name:s.name,
        line_code:s.lineCode||null, seq:i+1}))));
    if(bookingSeq&&bookingSeq.length){
      await db().from('trip_booking_seq').delete().eq('trip_id',tripId);
      ok(await db().from('trip_booking_seq').insert(bookingSeq.map(x=>({
        trip_id:tripId, booking_id:x.bookingId, seq:x.seq}))));
    }
    return true;
  };

  // the ordered sheet for one run
  N.runSheet=async function(tripId){
    const run=ok(await db().from('run_summary').select('*').eq('id',tripId).limit(1))[0];
    if(!run) throw new Error('run not found');
    const stops=ok(await db().from('trip_stops').select('*').eq('trip_id',tripId).order('seq'));
    const man=ok(await db().from('trip_manifest').select('*').eq('trip_id',tripId));
    const byBooking={};
    man.forEach(m=>{ if(!byBooking[m.booking_id]) byBooking[m.booking_id]={...m,pieces:0};
      byBooking[m.booking_id].pieces++; });
    const rows=Object.values(byBooking);
    // hang each consignment on its stop, using the booking's drop point name
    const bk=rows.length?ok(await db().from('bookings')
      .select('id,drop_point_name,receiver_name,receiver_phone,receiver_address,total_pieces,payment_type,grand_total,status,booking_number')
      .in('id',rows.map(r=>r.booking_id))):[];
    // how long each undelivered consignment has been waiting (file 39).
    // Fetched separately rather than switching the query to road_map, so the
    // stop grouping below keeps using exactly the field it always has.
    let ageBy={};
    if(rows.length){
      try{
        const age=ok(await db().from('road_map')
          .select('booking_id,undelivered_days,failed_attempts')
          .in('booking_id',rows.map(r=>r.booking_id)));
        ageBy=Object.fromEntries(age.map(a=>[a.booking_id,a]));
      }catch(e){ console.warn('undelivered age unavailable',e.message); }
    }
    // per-LR order, set on the Road Map screen before this Load Sheet was
    // created. Older runs (created before this existed) simply have no rows
    // here, so they fall back to booking_number — same as before.
    let seqBy={};
    if(rows.length){
      try{
        const sq=ok(await db().from('trip_booking_seq').select('booking_id,seq').eq('trip_id',tripId));
        seqBy=Object.fromEntries(sq.map(s=>[s.booking_id,s.seq]));
      }catch(e){ console.warn('booking order unavailable',e.message); }
    }
    const byStop={};
    bk.forEach(b=>{ const k=(b.drop_point_name||'(no drop point)');
      const a=ageBy[b.id]||{};
      b.undelivered_days=(a.undelivered_days==null?null:a.undelivered_days);
      b.failed_attempts=a.failed_attempts||0;
      (byStop[k]=byStop[k]||[]).push(b); });
    const bySeq=(a,b)=>{
      const sa=seqBy[a.id], sb=seqBy[b.id];
      if(sa!=null&&sb!=null) return sa-sb;
      if(sa!=null) return -1;
      if(sb!=null) return 1;
      return String(a.booking_number).localeCompare(String(b.booking_number));
    };
    Object.values(byStop).forEach(list=>list.sort(bySeq));
    return {run, stops:stops.map(s=>({...s,items:byStop[s.stop_name]||[]})),
            unplaced:Object.keys(byStop).filter(k=>!stops.some(s=>s.stop_name===k))
                      .map(k=>({name:k,items:byStop[k]}))};
  };

  // evening: vehicle is back
  N.closeRun=async function(tripId,closeKm,diesel){
    const t=ok(await db().from('trips').select('open_km').eq('id',tripId).limit(1))[0];
    if(!t) throw new Error('run not found');
    if(closeKm!=null && t.open_km!=null && closeKm < t.open_km)
      throw new Error('Closing KM ('+closeKm+') cannot be less than opening KM ('+t.open_km+')');
    ok(await db().from('trips').update({
      close_km:(closeKm!=null?closeKm:null),
      diesel_litres:(diesel!=null?diesel:null),
      closed_at:new Date().toISOString(),
      status:'arrived', arrived_at:new Date().toISOString()
    }).eq('id',tripId));
    return true;
  };

  // consignments today that are not on any run yet
  N.notOnAnyRun=async function(branchCode,date){
    const rm=await N.roadMap(branchCode,date,'line');
    const all=[];
    rm.groups.forEach(g=>g.stops.forEach(s=>s.items.forEach(i=>all.push(i))));
    if(!all.length) return [];
    const runs=await N.runsFor(branchCode,date);
    if(!runs.length) return all;
    const ti=ok(await db().from('trip_manifest').select('booking_id,trip_id')
      .in('trip_id',runs.map(r=>r.id)));
    const on=new Set(ti.map(x=>x.booking_id));
    return all.filter(i=>!on.has(i.booking_id));
  };
})();

/* ---- LR register: every booking with full detail, for screen and CSV ---- */
(function(){
  const N=window.N2K;
  const db=()=>N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const from0=d=>new Date(d+'T00:00:00').toISOString();
  const to24 =d=>new Date(d+'T23:59:59.999').toISOString();

  N.bookingsRange=async function(from,to,branchCode){
    const F=await N.facilities();
    let q=db().from('bookings').select(
      'id,booking_number,created_at,status,delivery_type,drop_point_name,freight_basis,'+
      'total_pieces,total_weight_kg,freight_total,total_loading_charges,docket_charges,grand_total,'+
      'payment_type,transaction_mode,eway_bill_number,receiver_name,receiver_phone,receiver_address,'+
      'cancelled_at,cancel_reason,'+
      'receiver_city,receiver_pincode,receiver_gstin,notes,'+
      'customer:customer_id(name,contact_phone,gstin),'+
      'origin:origin_facility_id(code,name),dest:destination_facility_id(code,name,kind)')
      .gte('created_at',from0(from)).lte('created_at',to24(to))
      .order('created_at',{ascending:false}).limit(5000);
    if(branchCode){
      const f=F.byCode[branchCode];
      if(f){
        const mine=F.list.filter(x=>x.id===f.id||x.parent_facility_id===f.id).map(x=>x.id);
        q=q.or('origin_facility_id.eq.'+f.id+',destination_facility_id.in.('+mine.join(',')+')');
      }
    }
    const rows=ok(await q);
    if(!rows.length) return [];
    const ids=rows.map(r=>r.id);
    // delivery time + who received it, from the delivery scan
    let delivered={};
    try{
      const sc=ok(await db().from('scan_events').select('booking_id,scanned_at,note')
        .in('booking_id',ids).eq('scan_type','delivered'));
      sc.forEach(s=>{ if(!delivered[s.booking_id]) delivered[s.booking_id]=s; });
    }catch(e){}
    // invoices / e-way bills
    let invs={};
    try{
      const iv=ok(await db().from('booking_invoices')
        .select('booking_id,invoice_no,invoice_value,gst_value,eway_bill_number').in('booking_id',ids));
      iv.forEach(x=>{ (invs[x.booking_id]=invs[x.booking_id]||[]).push(x); });
    }catch(e){}
    return rows.map(r=>{
      const iv=invs[r.id]||[];
      const dl=delivered[r.id];
      const due=(r.payment_type==='to_pay')?(parseFloat(r.grand_total)||0):0;
      return {...r,
        invoice_nos: iv.map(x=>x.invoice_no).filter(Boolean).join(' | '),
        invoice_value: iv.reduce((a,x)=>a+(parseFloat(x.invoice_value)||0),0)||null,
        gst_value: iv.reduce((a,x)=>a+(parseFloat(x.gst_value)||0),0)||null,
        eway_bills: (iv.map(x=>x.eway_bill_number).filter(Boolean).join(' | ')
                     || r.eway_bill_number || ''),
        delivered_at: dl?dl.scanned_at:null,
        received_by: dl&&dl.note?String(dl.note).replace(/^Delivered to\s*/i,'').split(' · ')[0]:'',
        collected: (dl && due)?due:0,
        to_collect: (!dl && due)?due:0
      };
    });
  };
})();

/* ---- what is already loaded on a run today ---- */
(function(){
  const N=window.N2K;
  const db=()=>N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  // Which consignments are spoken for and cannot be loaded onto a new run.
  //
  // Only OPEN runs count. A closed run means the vehicle is back at the branch,
  // so anything on it that was not delivered — an undelivered consignment sits
  // in that manifest forever — must be free to go out again. Counting closed
  // runs locked undelivered LRs out of every future run permanently.
  //
  // Delivered consignments need no special handling: road_map only returns open
  // statuses, so they never reach this list in the first place.
  N.assignedMap=async function(branchCode,date){
    const all=await N.runsFor(branchCode,date);
    const runs=all.filter(r=>!r.closed_at);
    if(!runs.length) return {};
    const m={};
    try{
      const rows=ok(await db().from('trip_manifest').select('booking_id,trip_id')
        .in('trip_id',runs.map(r=>r.id)));
      const byTrip={}; runs.forEach(r=>byTrip[r.id]=r.trip_number);
      rows.forEach(x=>{ m[x.booking_id]=byTrip[x.trip_id]||'a run'; });
    }catch(e){}
    return m;
  };
})();

/* ---- crew and vehicles already out on an open run today ---- */
(function(){
  const N=window.N2K;
  N.crewBusy=async function(branchCode,date){
    const busy={vehicles:{},drivers:{},helpers:{}};
    try{
      const runs=await N.runsFor(branchCode,date);
      runs.filter(r=>!r.closed_at).forEach(r=>{
        if(r.vehicle_id) busy.vehicles[r.vehicle_id]=r.trip_number;
        if(r.driver_id)  busy.drivers[r.driver_id]=r.trip_number;
        if(r.helper_id)  busy.helpers[r.helper_id]=r.trip_number;
      });
    }catch(e){}
    return busy;
  };
})();

/* ---- find a customer by part of a name or a phone number ---- */
(function(){
  const N=window.N2K;
  const db=()=>N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const clean=s=>String(s||'').trim();

  N.searchParties=async function(q){
    const s=clean(q);
    if(s.length<2) return [];
    const like='%'+s.replace(/[%,]/g,'')+'%';
    const out=[]; const seen=new Set();
    const add=(name,phone,gstin,kind,src)=>{
      const key=(phone||'')+'|'+(name||'').toLowerCase();
      if(!name&&!phone) return;
      if(seen.has(key)) return;
      seen.add(key);
      out.push({name:name||'',phone:phone||'',gstin:gstin||'',kind:kind||'individual',source:src});
    };
    // 1. customers (people who have sent before)
    try{
      const c=ok(await db().from('customers')
        .select('name,contact_phone,gstin,kind')
        .or('name.ilike.'+like+',contact_phone.ilike.'+like).limit(8));
      c.forEach(x=>add(x.name,x.contact_phone,x.gstin,x.kind,'customer'));
    }catch(e){}
    // 2. receivers seen on past bookings
    try{
      const b=ok(await db().from('bookings')
        .select('receiver_name,receiver_phone,receiver_gstin,receiver_kind,created_at')
        .or('receiver_name.ilike.'+like+',receiver_phone.ilike.'+like)
        .order('created_at',{ascending:false}).limit(12));
      b.forEach(x=>add(x.receiver_name,x.receiver_phone,x.receiver_gstin,x.receiver_kind,'past delivery'));
    }catch(e){}
    return out.slice(0,8);
  };
})();

/* ---- admin reports: outstanding, delivery performance, line profitability ---- */
(function(){
  const N=window.N2K;
  const db=()=>N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const from0=d=>new Date(d+'T00:00:00').toISOString();
  const to24 =d=>new Date(d+'T23:59:59.999').toISOString();

  async function scopeIds(branchCode){
    if(!branchCode) return null;
    const F=await N.facilities();
    const f=F.byCode[branchCode];
    if(!f) return null;
    return F.list.filter(x=>x.id===f.id||x.parent_facility_id===f.id).map(x=>x.id);
  }

  /* 1. OUTSTANDING — To Pay money not yet collected, aged */
  N.outstanding=async function(branchCode){
    // everything that is not Paid: To Pay and On Acct To Pay are cash due on
    // delivery; On Account is credit billed to the customer's account.
    const CASH=['to_pay','on_account_to_pay'], CREDIT=['on_account'];
    let q=db().from('bookings').select(
      'id,booking_number,created_at,status,payment_type,grand_total,total_pieces,'+
      'receiver_name,receiver_phone,drop_point_name,'+
      'customer:customer_id(name,contact_phone),'+
      'origin:origin_facility_id(code,name),dest:destination_facility_id(code,name)')
      .in('payment_type',CASH.concat(CREDIT)).is('cancelled_at',null)
      .neq('status','returned').limit(4000);
    const mine=await scopeIds(branchCode);
    if(mine) q=q.in('destination_facility_id',mine);
    let rows=ok(await q);
    // cash-on-delivery types settle when delivered; credit stays until billed
    rows=rows.filter(r=>CREDIT.includes(r.payment_type) || r.status!=='delivered');
    const now=Date.now();
    const bucket=d=>{const days=(now-new Date(d).getTime())/864e5;
      return days<=2?'0-2 days':days<=7?'3-7 days':days<=15?'8-15 days':'over 15 days';};
    const ORDER=['0-2 days','3-7 days','8-15 days','over 15 days'];
    const PAYL={to_pay:'To Pay',on_account:'On Account',on_account_to_pay:'On Acct To Pay'};
    const byBranch={}, byAge={}, byType={};
    ORDER.forEach(k=>byAge[k]={bucket:k,count:0,amount:0});
    let cash=0, credit=0;
    rows.forEach(r=>{
      const amt=parseFloat(r.grand_total)||0;
      const b=(r.dest&&r.dest.code)||(r.origin&&r.origin.code)||'\u2014';
      byBranch[b]=byBranch[b]||{code:b,name:(r.dest&&r.dest.name)||b,count:0,amount:0,oldest:0,cash:0,credit:0};
      byBranch[b].count++; byBranch[b].amount+=amt;
      if(CREDIT.includes(r.payment_type)){ credit+=amt; byBranch[b].credit+=amt; }
      else { cash+=amt; byBranch[b].cash+=amt; }
      const age=now-new Date(r.created_at).getTime();
      if(age>byBranch[b].oldest) byBranch[b].oldest=age;
      const k=bucket(r.created_at); byAge[k].count++; byAge[k].amount+=amt;
      const p=PAYL[r.payment_type]||r.payment_type;
      byType[p]=byType[p]||{type:p,count:0,amount:0};
      byType[p].count++; byType[p].amount+=amt;
      r._bucket=k; r._amount=amt; r._payLabel=p;
      r._credit=CREDIT.includes(r.payment_type);
    });
    return {rows, byBranch:Object.values(byBranch).sort((a,b)=>b.amount-a.amount),
            byAge:ORDER.map(k=>byAge[k]),
            byType:Object.values(byType).sort((a,b)=>b.amount-a.amount),
            cash, credit,
            total:rows.reduce((a,r)=>a+(parseFloat(r.grand_total)||0),0)};
  };

  /* 2. DELIVERY PERFORMANCE — success rate and how long it takes */
  N.deliveryPerformance=async function(from,to,branchCode){
    let q=db().from('bookings').select(
      'id,created_at,status,total_pieces,destination_facility_id,'+
      'origin:origin_facility_id(code),dest:destination_facility_id(code,name,kind),'+
      'drop:drop_point_id(facility_id,line:facility_id(code,name))')
      .is('cancelled_at',null)
      .gte('created_at',from0(from)).lte('created_at',to24(to)).limit(5000);
    const mine=await scopeIds(branchCode);
    if(mine) q=q.in('destination_facility_id',mine);
    const rows=ok(await q);
    if(!rows.length) return {groups:[],total:{booked:0,delivered:0,failed:0,pending:0,hours:null}};
    const items=ok(await db().from('consignment_items')
      .select('booking_id,delivered_at').in('booking_id',rows.map(r=>r.id)).limit(20000));
    const dl={}; items.forEach(i=>{ if(i.delivered_at && !dl[i.booking_id]) dl[i.booking_id]=i.delivered_at; });
    const g={};
    rows.forEach(r=>{
      const key=(r.drop&&r.drop.line&&r.drop.line.name) || (r.dest&&r.dest.name) || '—';
      const code=(r.drop&&r.drop.line&&r.drop.line.code) || (r.dest&&r.dest.code) || '';
      g[key]=g[key]||{name:key,code,booked:0,delivered:0,failed:0,pending:0,hoursSum:0,hoursN:0};
      const x=g[key]; x.booked++;
      if(r.status==='delivered'){ x.delivered++;
        if(dl[r.id]){ x.hoursSum+=(new Date(dl[r.id])-new Date(r.created_at))/36e5; x.hoursN++; }
      }else if(r.status==='delivery_failed') x.failed++;
      else x.pending++;
    });
    const groups=Object.values(g).map(x=>({...x,
      rate: x.booked?Math.round(x.delivered/x.booked*100):0,
      avgHours: x.hoursN?(x.hoursSum/x.hoursN):null})).sort((a,b)=>b.booked-a.booked);
    const T=groups.reduce((a,x)=>({booked:a.booked+x.booked,delivered:a.delivered+x.delivered,
      failed:a.failed+x.failed,pending:a.pending+x.pending,
      hoursSum:a.hoursSum+x.hoursSum,hoursN:a.hoursN+x.hoursN}),
      {booked:0,delivered:0,failed:0,pending:0,hoursSum:0,hoursN:0});
    return {groups,total:{...T, rate:T.booked?Math.round(T.delivered/T.booked*100):0,
      hours:T.hoursN?(T.hoursSum/T.hoursN):null}};
  };

  /* 3. LINE PROFITABILITY — income vs running cost, per line */
  N.lineProfit=async function(from,to,branchCode){
    let q=db().from('account_sheet').select('*').gte('close_date',from).lte('close_date',to);
    if(branchCode) q=q.eq('branch_code',branchCode);
    const rows=ok(await q);
    const num=v=>parseFloat(v)||0;
    const g={};
    rows.forEach(r=>{
      const k=r.line||'(not set)';
      g[k]=g[k]||{line:k,branch:r.branch_code,days:0,income:0,fuel:0,mamool:0,misc:0,
                  wages:0,expense:0,km:0,diesel:0,loaded:0,delivered:0,undelivered:0};
      const x=g[k];
      x.days++; x.income+=num(r.income); x.fuel+=num(r.fuel_expense);
      x.mamool+=num(r.mamool_expense); x.misc+=num(r.misc_expense);
      x.wages+=num(r.driver_wage)+num(r.helper_wage);
      x.expense+=num(r.total_expense); x.km+=num(r.run_km); x.diesel+=num(r.diesel_litres);
      x.loaded+=r.loaded_qty||0; x.delivered+=r.delivered_qty||0; x.undelivered+=r.undelivered_qty||0;
    });
    const groups=Object.values(g).map(x=>({...x,
      margin:x.income-x.expense,
      marginPct: x.income?Math.round((x.income-x.expense)/x.income*100):0,
      perKm: x.km?((x.income-x.expense)/x.km):null,
      kmpl: x.diesel?(x.km/x.diesel):null})).sort((a,b)=>b.margin-a.margin);
    const T=groups.reduce((a,x)=>({income:a.income+x.income,expense:a.expense+x.expense,
      fuel:a.fuel+x.fuel,mamool:a.mamool+x.mamool,misc:a.misc+x.misc,wages:a.wages+x.wages,
      km:a.km+x.km,diesel:a.diesel+x.diesel}),
      {income:0,expense:0,fuel:0,mamool:0,misc:0,wages:0,km:0,diesel:0});
    return {groups,total:{...T,margin:T.income-T.expense,
      marginPct:T.income?Math.round((T.income-T.expense)/T.income*100):0}};
  };
})();

/* ===========================================================================
   masters v3 — driver licence types & hub, vehicle paperwork, vehicle service,
   Aadhaar and scanned documents.

   Written as overrides at the end of the file, the same way saveUser is wrapped
   above, so the original definitions stay readable and nothing earlier moves.

   Aadhaar and documents NEVER travel through a normal table query: party_private
   and party_documents have RLS on with no policies (file 32), so every read and
   write goes through a SECURITY DEFINER function that re-checks the admin's own
   password. See 32_party_private_docs.sql.
   =========================================================================== */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const LICENCE_TYPES=['Light','Badge','Heavy'];
  N.LICENCE_TYPES=LICENCE_TYPES;

  const nn=v=>{const s=(v==null?'':String(v)).trim();return s===''?null:s;};
  const num=v=>{const s=nn(v);if(s===null)return null;const n=parseFloat(s.replace(/,/g,''));
    return isNaN(n)?null:n;};
  const int=v=>{const s=nn(v);if(s===null)return null;const n=parseInt(String(s).replace(/[^0-9-]/g,''),10);
    return isNaN(n)?null:n;};
  const dt=v=>nn(v);              // <input type=date> already yields YYYY-MM-DD

  /* ---------------- drivers: licence types + home hub ---------------- */
  N.masters.loadDrivers=async function(){
    const d=ok(await sb.from('drivers')
      .select('id,license_number,license_expiry,license_types,'+
              'user:user_id(id,full_name,phone,is_active,facility:facility_id(code,name))')
      .order('created_at'));
    return d.map(x=>({
      _id:x.id,_uid:x.user?x.user.id:null,
      name:x.user?x.user.full_name:'—',
      phone:x.user?x.user.phone||'':'',
      lic:x.license_number||'',
      exp:x.license_expiry||'',
      ltypes:(x.license_types||[]).join(','),
      hub:(x.user&&x.user.facility)?x.user.facility.code:'',
      active:x.user?x.user.is_active:true}));
  };

  N.masters.saveDriver=async function(v,row){
    const types=String(v.ltypes||'').split(',').map(s=>s.trim())
      .filter(s=>LICENCE_TYPES.indexOf(s)>=0);
    const hubId=v.hub?await N.facIdFor(v.hub,['branch','hub']):null;
    if(row&&row._uid){
      ok(await sb.from('users').update({full_name:v.name,phone:v.phone,facility_id:hubId})
        .eq('id',row._uid));
      ok(await sb.from('drivers').update({license_number:v.lic,
        license_expiry:dt(v.exp),license_types:types}).eq('id',row._id));
      return row._id;
    }
    const u=ok(await sb.from('users').insert({full_name:v.name,phone:v.phone,
      role:'driver',password_hash:'db-managed',facility_id:hubId,
      is_active:true,must_change_password:true}).select('id'))[0];
    const d=ok(await sb.from('drivers').insert({user_id:u.id,license_number:v.lic,
      license_expiry:dt(v.exp),license_types:types}).select('id'))[0];
    return d.id;
  };

  /* ---------------- helpers: unchanged shape, id returned for documents ------ */
  N.masters.saveHelper=async function(v,id){
    const body={full_name:v.name,phone:nn(v.phone),facility_id:await N.facIdFor(v.branch,['branch','hub'])};
    if(id){ ok(await sb.from('helpers').update(body).eq('id',id)); return id; }
    const h=ok(await sb.from('helpers').insert(Object.assign({},body,{is_active:true})).select('id'))[0];
    return h.id;
  };

  /* ---------------- vehicles: full paperwork ---------------- */
  const VCOLS='id,label,registration,capacity_kg,status,rc_number,chassis_number,engine_number,'+
    'insurance_number,insurance_provider,insurance_from,insurance_to,'+
    'permit_number,permit_from,permit_to,tax_number,tax_amount,puc_number,puc_from,puc_to';

  N.masters.loadVehicles=async function(){
    const d=ok(await sb.from('vehicles').select(VCOLS).order('label'));
    return d.map(v=>({_id:v.id,label:v.label,reg:v.registration,
      cap:v.capacity_kg?String(Math.round(v.capacity_kg)):'',
      rc:v.rc_number||'',chassis:v.chassis_number||'',engine:v.engine_number||'',
      insno:v.insurance_number||'',insco:v.insurance_provider||'',
      insfrom:v.insurance_from||'',insto:v.insurance_to||'',
      permitno:v.permit_number||'',permitfrom:v.permit_from||'',permitto:v.permit_to||'',
      taxno:v.tax_number||'',taxamt:v.tax_amount!=null?String(v.tax_amount):'',
      pucno:v.puc_number||'',pucfrom:v.puc_from||'',pucto:v.puc_to||'',
      active:v.status!=='out_of_service'}));
  };

  N.masters.saveVehicle=async function(v,id){
    const body={label:v.label,registration:v.reg,capacity_kg:num(v.cap),
      rc_number:nn(v.rc),chassis_number:nn(v.chassis),engine_number:nn(v.engine),
      insurance_number:nn(v.insno),insurance_provider:nn(v.insco),
      insurance_from:dt(v.insfrom),insurance_to:dt(v.insto),
      permit_number:nn(v.permitno),permit_from:dt(v.permitfrom),permit_to:dt(v.permitto),
      tax_number:nn(v.taxno),tax_amount:num(v.taxamt),
      puc_number:nn(v.pucno),puc_from:dt(v.pucfrom),puc_to:dt(v.pucto)};
    if(id){ ok(await sb.from('vehicles').update(body).eq('id',id)); return id; }
    const r=ok(await sb.from('vehicles').insert(Object.assign({},body,{status:'available'})).select('id'))[0];
    return r.id;
  };

  N.vehicleOptions=async function(){
    const d=ok(await sb.from('vehicles').select('id,label,registration')
      .neq('status','out_of_service').order('label'));
    return d.map(v=>v.registration+' \u2014 '+v.label);
  };

  /* ---------------- service types (the dropdown the admin maintains) -------- */
  N.masters.loadServiceTypes=async function(){
    const d=ok(await sb.from('service_types').select('id,name,is_active').order('name'));
    return d.map(t=>({_id:t.id,name:t.name,active:t.is_active}));
  };
  N.masters.saveServiceType=async function(v,id){
    const body={name:v.name};
    if(id) ok(await sb.from('service_types').update(body).eq('id',id));
    else ok(await sb.from('service_types').insert(Object.assign({},body,{is_active:true})));
  };
  N.serviceTypeOptions=async function(){
    const d=ok(await sb.from('service_types').select('name').eq('is_active',true).order('name'));
    return d.map(t=>t.name);
  };

  /* ---------------- vehicle service records ---------------- */
  N.masters.loadVehicleServices=async function(){
    const d=ok(await sb.from('vehicle_services')
      .select('id,service_date,km_at_service,next_due_km,next_due_date,expense_amount,notes,'+
              'vehicle:vehicle_id(id,label,registration),type:service_type_id(id,name)')
      .order('service_date',{ascending:false}).limit(500));
    return d.map(s=>({_id:s.id,
      vehicle:s.vehicle?(s.vehicle.registration+' \u2014 '+s.vehicle.label):'',
      date:s.service_date||'',
      stype:s.type?s.type.name:'',
      km:s.km_at_service!=null?String(s.km_at_service):'',
      duekm:s.next_due_km!=null?String(s.next_due_km):'',
      duedate:s.next_due_date||'',
      cost:s.expense_amount!=null?String(s.expense_amount):'',
      notes:s.notes||'',
      active:true}));
  };
  N.masters.saveVehicleService=async function(v,id){
    const reg=String(v.vehicle||'').split('\u2014')[0].trim();
    if(!reg) throw new Error('Pick a vehicle');
    const veh=ok(await sb.from('vehicles').select('id').eq('registration',reg).limit(1));
    if(!veh.length) throw new Error('"'+reg+'" is not a vehicle in the register');

    let typeId=null;
    if(nn(v.stype)){
      const t=ok(await sb.from('service_types').select('id').ilike('name',v.stype.trim()).limit(1));
      if(t.length) typeId=t[0].id;
    }
    const body={vehicle_id:veh[0].id,service_date:dt(v.date)||n2kTodayLocal(),
      service_type_id:typeId,km_at_service:int(v.km),next_due_km:int(v.duekm),
      next_due_date:dt(v.duedate),expense_amount:num(v.cost),notes:nn(v.notes)};
    if(body.next_due_km!=null&&body.km_at_service!=null&&body.next_due_km<body.km_at_service)
      throw new Error('Next service KM cannot be less than the KM at this service');
    if(id) ok(await sb.from('vehicle_services').update(body).eq('id',id));
    else ok(await sb.from('vehicle_services').insert(body));
  };

  // what is due, straight from the view (odometer comes from closed runs)
  N.serviceDue=async function(){
    const d=ok(await sb.from('vehicle_service_status')
      .select('vehicle_id,label,registration,last_service_date,next_due_km,next_due_date,'+
              'odometer_km,km_remaining,km_due_now,km_due_soon,date_due_now,date_due_soon'));
    return d;
  };

  /* ---------------- enable / disable for the new tabs ---------------- */
  N.masters.setActive=(function(orig){
    return async function(tab,row,on){
      if(tab==='servicetypes')
        return ok(await sb.from('service_types').update({is_active:on}).eq('id',row._id));
      return orig.call(this,tab,row,on);
    };
  })(N.masters.setActive);

  /* =========================================================================
     Aadhaar — never readable with the public key. Every call proves the admin.
     ========================================================================= */
  N.priv={
    // which records have an Aadhaar on file. No digits, so no password needed.
    async statusAll(ownerType){
      const d=ok(await sb.rpc('party_private_status',{p_owner_type:ownerType}));
      return Object.fromEntries((d||[]).map(r=>[r.owner_id,r.has_aadhaar]));
    },
    async get(adminPhone,adminPass,ownerType,ownerId){
      return ok(await sb.rpc('party_private_get',{p_admin_phone:adminPhone,
        p_admin_password:adminPass,p_owner_type:ownerType,p_owner_id:ownerId}));
    },
    async set(adminPhone,adminPass,ownerType,ownerId,aadhaar){
      ok(await sb.rpc('party_private_set',{p_admin_phone:adminPhone,
        p_admin_password:adminPass,p_owner_type:ownerType,p_owner_id:ownerId,
        p_aadhaar:aadhaar==null?null:String(aadhaar)}));
      return true;
    },
    // 1234 5678 9012 -> XXXX XXXX 9012
    mask(v){
      const s=String(v||'').replace(/[^0-9]/g,'');
      return s.length===12?('XXXX XXXX '+s.slice(8)):(s||'');
    },
    group(v){
      const s=String(v||'').replace(/[^0-9]/g,'').slice(0,12);
      return s.replace(/(.{4})(?=.)/g,'$1 ').trim();
    }
  };

  /* =========================================================================
     Documents. The index lives in Postgres; the files live in the private
     n2k-docs bucket and are reached only through the doc-access Edge Function,
     which signs a short-lived URL after checking the admin password. The
     browser never holds a key that can read the bucket.
     ========================================================================= */
  const FN_URL=(N.SUPABASE_URL||'').replace(/\/$/,'')+'/functions/v1/doc-access';

  async function callFn(action,payload){
    let res;
    try{
      res=await fetch(FN_URL,{method:'POST',
        headers:{'Content-Type':'application/json','apikey':N.SUPABASE_ANON_KEY||'',
                 'Authorization':'Bearer '+(N.SUPABASE_ANON_KEY||'')},
        body:JSON.stringify(Object.assign({action:action},payload))});
    }catch(e){
      throw new Error('Document service unreachable — check the internet connection');
    }
    if(res.status===404)
      throw new Error('Document storage is not switched on yet (Edge Function "doc-access" not deployed)');
    let body={};
    try{ body=await res.json(); }catch(e){}
    if(!res.ok) throw new Error(body.error||('Document service error '+res.status));
    return body;
  }

  N.docs={
    KINDS:{driver:['Licence','Aadhaar','Photo','Other'],
           helper:['Aadhaar','Photo','Other'],
           vehicle:['RC','Insurance','Permit','Pollution (PUC)','Tax receipt','Fitness (FC)','Other']},
    ACCEPT:'.pdf,.jpg,.jpeg,.png',
    MAX_BYTES:5*1024*1024,

    // how many papers each record holds, for the badge in the list
    async counts(ownerType){
      const d=ok(await sb.rpc('party_doc_counts',{p_owner_type:ownerType}));
      return Object.fromEntries((d||[]).map(r=>[r.owner_id,{n:r.n,expiring:r.expiring}]));
    },
    async list(adminPhone,adminPass,ownerType,ownerId){
      return ok(await sb.rpc('party_docs_list',{p_admin_phone:adminPhone,
        p_admin_password:adminPass,p_owner_type:ownerType,p_owner_id:ownerId}))||[];
    },
    // upload: ask the function for a signed upload slot, PUT the file, then index it
    async upload(adminPhone,adminPass,ownerType,ownerId,file,meta){
      if(!file) throw new Error('Choose a file first');
      if(file.size>this.MAX_BYTES) throw new Error('That file is larger than 5 MB');
      const mime=file.type||'';
      if(['application/pdf','image/jpeg','image/jpg','image/png'].indexOf(mime)<0)
        throw new Error('Only PDF, JPG and PNG files can be uploaded');

      const slot=await callFn('upload-url',{adminPhone,adminPass,ownerType,ownerId,
        fileName:file.name,mime});

      const put=await fetch(slot.url,{method:'PUT',
        headers:{'Content-Type':mime,'cache-control':'3600','x-upsert':'false'},
        body:file});
      if(!put.ok){
        let why='';
        try{ const j=await put.json(); why=j.message||j.error||''; }catch(e){}
        throw new Error('Upload failed'+(why?' — '+why:' ('+put.status+')')+' — try again');
      }

      ok(await sb.rpc('party_doc_add',{p_admin_phone:adminPhone,p_admin_password:adminPass,
        p_owner_type:ownerType,p_owner_id:ownerId,
        p_doc_kind:(meta&&meta.kind)||'other',p_title:(meta&&meta.title)||null,
        p_doc_number:(meta&&meta.number)||null,
        p_valid_from:(meta&&meta.from)||null,p_valid_to:(meta&&meta.to)||null,
        p_file_path:slot.path,p_file_name:file.name,p_mime:mime,p_size:file.size}));
      return true;
    },
    // download: a link that works for about a minute, then stops working
    async downloadUrl(adminPhone,adminPass,docId){
      const r=await callFn('download-url',{adminPhone,adminPass,docId});
      return r.url;
    },
    async remove(adminPhone,adminPass,docId){
      await callFn('remove',{adminPhone,adminPass,docId});
      return true;
    }
  };
})();

/* ===========================================================================
   Expiry alerts for the Dashboard (view created in file 37).

   Scope is applied here, in one place, so every caller gets the same rule:
     admin  — sees everything
     agent  — sees their own branch's driver licences, plus anything already
              expired anywhere. Vehicle papers and service due are company-wide
              and stay with the admin, because vehicles have no branch in this
              system to scope them by.
   =========================================================================== */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};

  N.ALERT_BUCKETS=[
    {k:'expired',lab:'Expired',      note:'act now'},
    {k:'7',      lab:'Within 7 days',note:'this week'},
    {k:'15',     lab:'Within 15 days',note:'this fortnight'},
    {k:'30',     lab:'Within 30 days',note:'this month'}
  ];

  N.alerts=async function(me){
    const rows=ok(await sb.from('expiry_alerts')
      .select('source,item,ref_id,name,ref_no,contact,scope,branch_code,'+
              'due_date,days_left,km_remaining,bucket,always_show,urgency')
      .order('urgency'));

    const isAdmin=me&&me.role==='admin';
    if(isAdmin) return rows;

    const mine=me&&me.branch?String(me.branch).toUpperCase():null;
    return rows.filter(r=>{
      if(r.always_show) return true;                 // expired reaches everyone
      if(r.scope!=='branch') return false;           // vehicle/service = admin only
      return mine && r.branch_code && String(r.branch_code).toUpperCase()===mine;
    });
  };
})();

/* ===========================================================================
   Every active drop point in the network, each carrying its line and its hub.

   Booking now starts from the drop point rather than the destination, so the
   counter needs to search all of them at once instead of asking "which drop
   points belong to this branch?". The chain is drop point -> line -> hub, via
   drop_points.facility_id and the line's parent_facility_id.
   =========================================================================== */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  let cache=null;

  N.dropPointsAll=async function(fresh){
    if(fresh) cache=null;
    if(cache) return cache;
    const F=await N.facilities(!!fresh);
    const d=ok(await sb.from('drop_points')
      .select('id,name,landmark,seq,facility_id')
      .eq('is_active',true).order('name'));
    cache=d.map(x=>{
      const fac=F.byId[x.facility_id]||null;
      let line=null, hub=null;
      if(fac){
        if(fac.kind==='line'){ line=fac; hub=F.byId[fac.parent_facility_id]||null; }
        else hub=fac;                       // drop point hung straight off a hub
      }
      return {id:x.id,name:x.name,landmark:x.landmark||'',seq:x.seq,
        lineCode:line?line.code:null, lineName:line?line.name:null,
        hubCode:hub?hub.code:null,    hubName:hub?hub.name:null,
        hubKind:hub?hub.kind:null};
    // a drop point whose hub cannot be resolved cannot fill in a destination,
    // so it is left out rather than offered and then failing silently
    }).filter(x=>x.hubCode);
    return cache;
  };
})();

/* ===========================================================================
   The printable road map sheet, shared by the Road Map page and Reports.

   It lives here rather than on either page so there is exactly ONE copy of the
   template — the same reason the LR template sits in this file. Two copies drift
   apart, and the one nobody is looking at is the one that prints wrong.
   =========================================================================== */
(function(){
  const N=window.N2K;
  const db=()=>N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const esc=v=>String(v==null?'':v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const rup=n=>'\u20B9'+(Math.round((+n||0)*100)/100).toLocaleString('en-IN');

  // every run between two dates; admin passes null for all branches
  N.runsRange=async function(branchCode,from,to){
    let q=db().from('run_summary').select('*')
      .gte('run_date',from).lte('run_date',to);
    if(branchCode) q=q.eq('origin_code',branchCode);
    return ok(await q.order('run_date',{ascending:false}).order('trip_number'));
  };

  // An undelivered consignment goes back on the next sheet automatically, so the
  // driver is told how long it has been waiting. Age counts from the FIRST failed
  // attempt, not the latest, so it keeps climbing across repeated tries.
  function remark(i){
    if(i.status!=='delivery_failed') return '';
    const d=i.undelivered_days;
    const age = d==null ? 'undelivered'
              : d<=0    ? 'undelivered today'
              : d===1   ? '1 day old'
                        : d+' days old';
    const tries=(i.failed_attempts||0)>1?` · ${i.failed_attempts} attempts`:'';
    return `<b class="old">${age}</b>${tries}`;
  }

  N.openRunSheet=async function(tripId,auto){
    let d;
    try{ d=await N.runSheet(tripId); }
    catch(e){ throw new Error('Cannot open the sheet \u2014 '+e.message); }
    const r=d.run;
    /* Pieces actually on the vehicle. A shortage recorded at loading means fewer
       pieces travel than were booked, and the driver hands over the smaller
       number — so the sheet must show that, not the booked figure, or the
       receiver counts 18 against a sheet claiming 20 and refuses to sign.

       Fetched HERE, above stopHtml, because stopHtml reads SHORTBY. */
    let SHORT=[], SHORTBY={};
    try{
      SHORT=(await N.shortagesFor(tripId))||[];
      SHORT.forEach(x=>{ if(x.action==='sent'&&x.short_qty) SHORTBY[x.booking_id]=x.short_qty; });
    }catch(e){}

    /* Signature boxes only on the Trip Sheet. The driver carries that one to the
       door; the Load Sheet never leaves the branch, so a box there is dead space.
       Declared BEFORE stopHtml, which uses it. */
    const SIGN = !!r.confirmed_at;

    // Per-LR delivery order, continuous down the whole sheet (not restarting
    // per stop) — items arrive from runSheet already sorted this way, this
    // just numbers them as they're printed. A plain mutable counter closed
    // over by stopHtml, since stops print one at a time in sequence.
    const itemSeq={n:0};

    const stopHtml=(name,landmark,line,items,n)=>`
      <div class="stop">
        <div class="sh"><span class="no">${n}</span><span class="nm">${esc(name)}</span>
          ${landmark?'<span class="lm">'+esc(landmark)+'</span>':''}
          ${line?'<span class="ln">'+esc(line)+'</span>':''}
          <span class="ct">${items.length} LR · ${
            items.reduce((a,i)=>a+Math.max(0,(i.total_pieces||0)-(SHORTBY[i.id]||0)),0)} pcs</span></div>
        <table><thead><tr><th class="seq"></th><th>LR</th><th>Consignee</th><th>Address / phone</th><th class="r">Pcs</th>
          <th>Payment</th><th class="r">Collect</th>
          <th style="width:${SIGN?'96px':'132px'}">Remark</th>
          ${SIGN?'<th class="sig">Receiver\'s signature &amp; seal</th>':''}</tr></thead>
          <tbody>${items.map(i=>{
            itemSeq.n++;
            const due=(i.payment_type==='to_pay')?(parseFloat(i.grand_total)||0):0;
            return `<tr><td class="seq"><span class="seqno">${itemSeq.n}</span></td><td class="mono">${i.booking_number}</td>
              <td>${esc(i.receiver_name||'—')}</td>
              <td class="dim">${esc((i.receiver_address||'').slice(0,44))}${i.receiver_phone?'<br>'+i.receiver_phone:''}</td>
              <td class="r">${(function(){
                const booked=i.total_pieces||0, sh=SHORTBY[i.id]||0;
                if(!sh) return booked||'';
                const going=Math.max(0,booked-sh);
                return '<b>'+going+'</b><div class="wasqty">was '+booked+'</div>';
              })()}</td>
              <td>${String(i.payment_type||'').replace(/_/g,' ')}</td>
              <td class="r ${due?'due':''}">${due?rup(due):'—'}</td>
              <td class="rmk">${remark(i)}</td>
              ${SIGN?'<td class="sig"><div class="sigbox"><span>SIGN &amp; SEAL</span></div></td>':''}
              </tr>`;}).join('')}
          </tbody></table></div>`;
    let n=0;
    const body=d.stops.map(s=>{n++;return stopHtml(s.stop_name,'',s.line_code,s.items,n);}).join('')+
      d.unplaced.map(u=>{n++;return stopHtml(u.name+' (not in the route order)','','',u.items,n);}).join('');
    /* ---- payment summary for the whole sheet ----
       Every payment type carried on this run, with how many LRs, pieces and
       rupees sit behind each. "To collect" counts To Pay only, matching the
       Delivery screen — On Account settles on the monthly bill, not at the
       door, so counting it here would send the driver asking for money that
       is not due. */
    const PAYLBL={prepaid:'Paid',to_pay:'To Pay',on_account:'On Account',
                  on_account_to_pay:'On Account To Pay'};
    const COLLECTIBLE={to_pay:true};
    const allItems=d.stops.reduce((a,s)=>a.concat(s.items),[])
                  .concat(d.unplaced.reduce((a,u)=>a.concat(u.items),[]));
    const pmap={};
    allItems.forEach(i=>{
      const k=i.payment_type||'unspecified';
      const e=pmap[k]||(pmap[k]={lrs:0,pcs:0,amt:0});
      // count what is TRAVELLING, so this table agrees with the rows below it
      e.lrs++; e.pcs+=Math.max(0,(i.total_pieces||0)-(SHORTBY[i.id]||0));
      e.amt+=parseFloat(i.grand_total)||0;
    });
    const pkeys=Object.keys(pmap).sort();
    const pTotLR=pkeys.reduce((a,k)=>a+pmap[k].lrs,0);
    const pTotPcs=pkeys.reduce((a,k)=>a+pmap[k].pcs,0);
    const pTotAmt=pkeys.reduce((a,k)=>a+pmap[k].amt,0);
    const pCollect=pkeys.reduce((a,k)=>a+(COLLECTIBLE[k]?pmap[k].amt:0),0);
    const paySumHtml = pkeys.length ? `
      <div class="psum"><table>
        <thead><tr><th>Payment type</th><th class="amt">LRs</th><th class="amt">Pieces</th>
          <th class="amt">Amount</th><th class="amt">To collect</th></tr></thead>
        <tbody>${pkeys.map(k=>`<tr>
          <td>${PAYLBL[k]||String(k).replace(/_/g,' ')}</td>
          <td class="amt">${pmap[k].lrs}</td>
          <td class="amt">${pmap[k].pcs}</td>
          <td class="amt">${rup(pmap[k].amt)}</td>
          <td class="amt ${COLLECTIBLE[k]?'coll':''}">${COLLECTIBLE[k]?rup(pmap[k].amt):'\u2014'}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td><td class="amt">${pTotLR}</td><td class="amt">${pTotPcs}</td>
          <td class="amt">${rup(pTotAmt)}</td><td class="amt coll">${rup(pCollect)}</td></tr></tfoot>
      </table></div>` : '';

    /* Shortages found when the load was checked travel WITH the sheet: the
       branch receiving the goods has to know what is missing before the
       customer opens the consignment. */

    const shortHtml = SHORT.length ? '<div class="psum"><table>'
      + '<thead><tr><th>Shortages recorded at loading</th><th class="amt">Short</th>'
      + '<th>Action</th><th>Note</th></tr></thead><tbody>'
      + SHORT.map(function(x){ return '<tr><td>'+esc(x.booking_number)+'</td>'
          + '<td class="amt">'+(x.short_qty==null?'\u2014':x.short_qty)+'</td>'
          + '<td>'+(x.action==='held'?'HELD BACK':'sent short')+'</td>'
          + '<td>'+esc(x.note||'')+'</td></tr>'; }).join('')
      + '</tbody></table></div>' : '';

    const totLR=d.stops.reduce((a,s)=>a+s.items.length,0)+d.unplaced.reduce((a,u)=>a+u.items.length,0);
    // the strip totals what is GOING, not what was booked
    const pcsOf=i=>Math.max(0,(i.total_pieces||0)-(SHORTBY[i.id]||0));
    const totPcs=d.stops.reduce((a,s)=>a+s.items.reduce((b,i)=>b+pcsOf(i),0),0)
               + d.unplaced.reduce((a,u)=>a+u.items.reduce((b,i)=>b+pcsOf(i),0),0);
    const bookedPcs=d.stops.reduce((a,s)=>a+s.items.reduce((b,i)=>b+(i.total_pieces||0),0),0)
                  + d.unplaced.reduce((a,u)=>a+u.items.reduce((b,i)=>b+(i.total_pieces||0),0),0);
    const collect=d.stops.reduce((a,s)=>a+s.items.reduce((b,i)=>b+((i.payment_type==='to_pay')?(parseFloat(i.grand_total)||0):0),0),0);
    const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${r.trip_number}</title>
      <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800;900&family=Inter:wght@400;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
      <style>
        @page{size:A4 portrait;margin:9mm}
        body{margin:0;font-family:Inter,Arial,sans-serif;color:#1B2340;-webkit-print-color-adjust:exact;print-color-adjust:exact}
        .rmk{font-size:9.5px;color:#6A7386}
        /* the booked figure, kept visible but clearly not what is travelling */
        .wasqty{font-size:7.5pt;color:#C0392B;font-weight:700;text-decoration:line-through;
          display:inline-block;margin-left:3px}
        /* Signature space, Trip Sheet only. Ruled but never filled, in keeping
           with the ink rule for every printed paper here — the box costs a
           thin outline and nothing else. About 22mm tall, which is the least
           that can actually take a signature and a rubber stamp. */
        .sig{width:150px;border-left:1px dashed #B9C0D0}
        td.sig{height:62px;padding:3px 6px;vertical-align:top}
        .sigbox{height:100%;min-height:54px;border:1px solid #D5DAE5;border-radius:3px;position:relative}
        .sigbox span{position:absolute;bottom:2px;left:0;right:0;text-align:center;
          font-size:6pt;color:#9AA2B4;letter-spacing:.06em}
        .rmk .old{color:#C0392B;font-weight:800}
        .barx{position:sticky;top:0;display:flex;gap:8px;align-items:center;padding:8px 10px;
          background:#1B2340;color:#fff;font-size:12px;font-weight:700}
        .barx button{border:0;border-radius:7px;padding:6px 14px;font-weight:800;cursor:pointer;
          font-family:inherit;font-size:12px}
        .barx .p{background:#C0392B;color:#fff}
        .barx .s{background:#fff;color:#1B2340}
        @media print{.barx{display:none}}
        .hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1.6px solid #1B2340;padding-bottom:7px;margin-bottom:9px}
        .hd .org{line-height:1}
        .hd .org .shlogo{height:34px;width:auto;display:block;margin-bottom:2px}
        .hd .org small{display:block;font-family:Inter,sans-serif;font-weight:700;font-size:9pt;color:#1B2340;margin-top:2px}
        .hd .r{text-align:right;font-size:9pt;line-height:1.5}
        .hd .r b{font-family:'IBM Plex Mono',monospace;font-size:12pt}
        .tot{display:flex;gap:18px;flex-wrap:wrap;font-size:12pt;font-weight:800;
          border:1.2px solid #1B2340;padding:9px 12px;margin-bottom:9px;line-height:1.5}
        .tot .v{font-family:'IBM Plex Mono',monospace;color:#1B2340}
        .tot .blank{font-family:'IBM Plex Mono',monospace;color:#6A7386;letter-spacing:1px}
        /* payment summary — what the driver is carrying, by payment type */
        .psum{width:100%;border:1.4px solid #1B2340;border-radius:6px;overflow:hidden;margin-bottom:10px}
        .psum table{width:100%;border-collapse:collapse;font-size:10pt}
        .psum th{font-size:8pt;padding:5px 10px;text-transform:uppercase;letter-spacing:.06em;
          color:#555;font-weight:800;border-bottom:1.2px solid #1B2340}
        .psum td{padding:5px 10px;border-bottom:1px solid #EEF1F7;font-weight:700}
        .psum tr:last-child td{border-bottom:0}
        .psum tfoot td{border-top:1.2px solid #1B2340;font-weight:900;font-size:10.5pt}
        .psum .amt{font-family:'IBM Plex Mono',monospace;text-align:right}
        .psum .coll{color:#C0392B}
        .closedtag{display:inline-block;background:#1B2340;color:#fff;font-size:8pt;font-weight:800;
          padding:2px 8px;border-radius:999px;margin-left:6px;letter-spacing:.04em}
        .stop{border:1px solid #1B2340;margin-bottom:7px;page-break-inside:auto}
        thead{display:table-header-group}
        tr{page-break-inside:avoid}
        .sh{display:flex;align-items:center;gap:8px;padding:5px 9px;background:#EEF1F7;border-bottom:1px solid #1B2340}
        .sh .no{width:19px;height:19px;border-radius:50%;background:#2F4079;color:#fff;font-weight:800;
          font-size:9pt;display:flex;align-items:center;justify-content:center}
        .sh .nm{font-weight:800;font-size:11pt}
        .sh .lm,.sh .ln{font-size:8pt;color:#6A7386}
        .sh .ct{margin-left:auto;font-size:8.5pt;color:#6A7386;font-weight:700}
        table{width:100%;border-collapse:collapse;font-size:8.6pt}
        th{text-align:left;font-size:7pt;letter-spacing:.05em;text-transform:uppercase;color:#6A7386;
          padding:3px 9px;border-bottom:1px solid #C9CFDD;font-weight:700}
        td{padding:4px 9px;border-bottom:1px solid #EEF1F7}
        tr:last-child td{border-bottom:0}
        .r{text-align:right}.mono{font-family:'IBM Plex Mono',monospace}
        .dim{color:#6A7386}.due{color:#C0392B;font-weight:800}
        /* per-LR delivery order badge — open circle, not filled, so it costs
           the printer an outline rather than a solid disc on every row */
        .seq{width:22px}
        .seqno{width:18px;height:18px;border-radius:50%;background:#fff;border:1.4px solid #1B2340;color:#1B2340;
          font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:8pt;display:flex;align-items:center;justify-content:center}
      </style></head><body${auto===false?'':' onload="window.print()"'}>
      ${auto===false?`<div class="barx"><span>Trip \u2014 ${r.trip_number}</span>
        <button class="p" onclick="window.print()">Print</button>
        <button class="s" onclick="window.print()">Save as PDF</button>
        <span style="opacity:.7;font-weight:500">choose &ldquo;Save as PDF&rdquo; as the printer to download</span></div>`:''}
      <div class="hd">
        <div class="org"><img class="shlogo" src="${N.LOGO}" alt="N2K Logistics"><small>${r.confirmed_at?'Trip Sheet':'Load Sheet \u2014 for checking'} \u00b7 driver\'s copy</small></div>
        <div class="r"><b>${r.trip_number}</b>
          <div>${esc(r.vehicle||'')} ${r.registration?'· '+esc(r.registration):''}</div>
          <div>Driver ${esc(r.driver||'—')}${r.helper?' · Helper '+esc(r.helper):''}</div>
          <div>${r.run_date} · from ${esc(r.origin_name||'')}${r.closed_at?'<span class="closedtag">RUN CLOSED</span>':''}</div></div>
      </div>
      <div class="tot">
        <span>${d.stops.length+d.unplaced.length} stops</span>
        <span>${totLR} LR</span>
        <span>${totPcs} pieces${bookedPcs>totPcs?' <span class="wasqty">of '+bookedPcs+' booked</span>':''}</span>
        <span>To collect <span class="v">${rup(collect)}</span></span>
        <span>Open KM <span class="v">${r.open_km??'____'}</span></span>
        <span>Close KM ${r.close_km!=null?`<span class="v">${r.close_km}</span>`:'<span class="blank">____</span>'}</span>
        <span>Run KM ${r.run_km!=null?`<span class="v">${r.run_km}</span>`:'<span class="blank">____</span>'}</span>
        <span>Diesel ${r.diesel_litres!=null?`<span class="v">${r.diesel_litres}</span>`:'<span class="blank">____</span>'} L</span>
      </div>
      ${shortHtml}${paySumHtml}
      ${body}
      </body></html>`;
    const w=window.open('','_blank','width=900,height=1000');
    if(!w) return say('err','Pop-up blocked — allow pop-ups to print the road map.');
    w.document.write(html); w.document.close();
  };
})();

/* ===========================================================================
   LOAD SHEET → TRIP SHEET (file 42)

   A run is built, then CHECKED, then confirmed. Before confirmation it is a
   Load Sheet: a provisional list the agent walks the goods against. After
   confirmation it is the Trip Sheet and cannot be quietly altered.

   Per LR the agent has three choices, and the middle one matters most — a
   consignment can travel with its shortage recorded, so the delivery end knows
   what is missing before the customer opens it.
   =========================================================================== */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  /* The session stores name, phone, role and branch — never a user id, because
     staff sign in with a mobile number and the id was never needed until now.
     So look the id up from the phone, once, and remember it. Passing an
     undefined p_by made PostgREST reject the whole call as a bad signature,
     which is why confirming did nothing at all. */
  let _uid=null, _uidFor=null;
  async function me(){
    const u=N.session.get();
    if(!u||!u.phone) return null;
    if(_uid && _uidFor===u.phone) return _uid;
    try{
      const d=ok(await sb.from('users').select('id').eq('phone',u.phone).limit(1));
      _uid = d.length?d[0].id:null; _uidFor=u.phone;
    }catch(e){ _uid=null; }
    return _uid;
  }

  // the LRs on a run, with any shortage already recorded against them
  N.loadSheet=async function(tripId){
    const rows=ok(await sb.from('trip_manifest')
      .select('trip_id,trip_number,trip_status,booking_id,booking_number,receiver_name,'+
              'receiver_phone,payment_type,grand_total,item_id')
      .eq('trip_id',tripId));
    // trip_manifest is one row per PIECE, so fold to one row per LR
    const byLR={};
    rows.forEach(r=>{
      const e=byLR[r.booking_id]||(byLR[r.booking_id]={booking_id:r.booking_id,
        booking_number:r.booking_number,receiver_name:r.receiver_name,
        receiver_phone:r.receiver_phone,payment_type:r.payment_type,
        grand_total:r.grand_total,pieces:0});
      e.pieces++;
    });
    let shorts={};
    try{
      const s=ok(await sb.from('load_shortage_view')
        .select('booking_id,short_qty,action,note').eq('trip_id',tripId));
      shorts=Object.fromEntries(s.map(x=>[x.booking_id,x]));
    }catch(e){ console.warn('shortages unavailable',e.message); }

    // a held LR has no pieces left on the run, so it is not in the manifest —
    // it has to be added back from the shortage record or it vanishes from view
    const held=[];
    try{
      const hs=ok(await sb.from('load_shortage_view')
        .select('booking_id,booking_number,receiver_name,total_pieces,short_qty,action,note')
        .eq('trip_id',tripId).eq('action','held'));
      hs.forEach(h=>{ if(!byLR[h.booking_id]) held.push({booking_id:h.booking_id,
        booking_number:h.booking_number,receiver_name:h.receiver_name,
        pieces:h.total_pieces||0,payment_type:null,grand_total:null}); });
    }catch(e){}

    const list=Object.values(byLR).concat(held)
      .sort((a,b)=>String(a.booking_number).localeCompare(String(b.booking_number)));
    list.forEach(l=>{ const s=shorts[l.booking_id];
      l.short_qty=s?s.short_qty:null; l.action=s?s.action:null; l.note=s?s.note:null; });
    return list;
  };

  // every one of these awaits me() first: an unresolved Promise passed as a
  // parameter is not a UUID, and PostgREST rejects the call rather than
  // ignoring it — silently, from the button's point of view
  N.loadHold=async function(t,b,q,n){
    return ok(await sb.rpc('load_hold_lr',
      {p_trip:t,p_booking:b,p_short:(q==null||isNaN(q))?null:q,p_note:n||null,p_by:await me()}));
  };
  N.loadNoteShort=async function(t,b,q,n){
    return ok(await sb.rpc('load_note_short',
      {p_trip:t,p_booking:b,p_short:(q==null||isNaN(q))?null:q,p_note:n||null,p_by:await me()}));
  };
  N.loadClear=async function(t,b){
    return ok(await sb.rpc('load_clear_short',{p_trip:t,p_booking:b}));
  };
  N.loadConfirm=async function(t){
    return ok(await sb.rpc('load_confirm',{p_trip:t,p_by:await me()}));
  };

  // shortages for the delivery end, so the branch receiving the goods knows
  N.shortagesFor=async function(tripId){
    try{
      return ok(await sb.from('load_shortage_view')
        .select('booking_id,booking_number,short_qty,action,note').eq('trip_id',tripId));
    }catch(e){ return []; }
  };
})();

/* ===========================================================================
   A vehicle's odometer carries forward: the closing reading of one run is the
   opening reading of the next. Typing it again invites transposed digits, and
   a wrong opening KM quietly corrupts both the run distance and the
   service-due-by-KM alert on the Dashboard.
   =========================================================================== */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};

  // the last closing reading for a vehicle, whatever branch or date it ran on
  N.lastCloseKm=async function(vehicleId){
    if(!vehicleId) return null;
    try{
      const d=ok(await sb.from('trips')
        .select('close_km,closed_at')
        .eq('vehicle_id',vehicleId)
        .not('close_km','is',null)
        .order('closed_at',{ascending:false})
        .limit(1));
      return d.length ? {km:d[0].close_km, at:d[0].closed_at} : null;
    }catch(e){ console.warn('last KM unavailable',e.message); return null; }
  };
})();

/* ===========================================================================
   Cancelling a consignment (file 44).

   Every rule lives in the database function, not here: only the origin branch,
   never once the run is confirmed, and the LR number is kept rather than
   reused. The screen only collects the reason and reports what comes back.
   =========================================================================== */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  let _uid=null,_uidFor=null;
  async function uid(){
    const u=N.session.get();
    if(!u||!u.phone) return null;
    if(_uid&&_uidFor===u.phone) return _uid;
    try{
      const d=ok(await sb.from('users').select('id').eq('phone',u.phone).limit(1));
      _uid=d.length?d[0].id:null; _uidFor=u.phone;
    }catch(e){ _uid=null; }
    return _uid;
  }

  N.cancelBooking=async function(bookingId,reason){
    const me=N.session.get();
    return ok(await sb.rpc('cancel_booking',{
      p_booking:bookingId, p_branch:(me&&me.branch)||null,
      p_reason:reason||null, p_by:await uid()}));
  };

  // can this consignment still be cancelled? asked before offering the button,
  // so the agent is not invited to do something that will then be refused
  N.cancellable=async function(bookingId){
    try{
      const b=ok(await sb.from('bookings')
        .select('status,cancelled_at,origin:origin_facility_id(code)')
        .eq('id',bookingId).limit(1))[0];
      if(!b) return {ok:false,why:'That consignment no longer exists'};
      if(b.cancelled_at) return {ok:false,why:'Already cancelled'};
      if(b.status==='delivered'||b.status==='returned')
        return {ok:false,why:'Already '+b.status};
      const me=N.session.get();
      const mine=me&&me.branch&&b.origin&&
        String(me.branch).toUpperCase()===String(b.origin.code).toUpperCase();
      if(!mine) return {ok:false,why:'Only '+(b.origin?b.origin.code:'the booking hub')+
        ' can cancel this — that is where it was booked'};

      const items=ok(await sb.from('consignment_items').select('id').eq('booking_id',bookingId));
      if(items.length){
        const ti=ok(await sb.from('trip_items')
          .select('trip_id').in('item_id',items.map(i=>i.id)));
        if(ti.length){
          const tr=ok(await sb.from('trips')
            .select('confirmed_at').in('id',[...new Set(ti.map(x=>x.trip_id))]));
          if(tr.some(t=>t.confirmed_at))
            return {ok:false,why:'Already on a confirmed run — hold it back at loading or return it'};
        }
      }
      return {ok:true};
    }catch(e){ return {ok:false,why:e.message}; }
  };

  N.CANCEL_REASONS=['Customer changed their mind','Booked in error',
    'Wrong destination or drop point','Goods not handed over','Duplicate booking','Other'];
})();

/* ===========================================================================
   Customers master (file 45).

   The table has always filled itself from bookings; this is what lets anyone
   see and correct it. Matching is on the MOBILE, so an imported list merges
   with customers the agents already created rather than duplicating them.
   =========================================================================== */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};

  /* Paged and searched IN THE DATABASE.

     Supabase caps any table query at 1,000 rows whatever limit is asked for, so
     the first version showed 1,000 of 9,000 and searched only within those —
     silently, which is the worst way to be wrong. Paging and searching both
     have to happen server-side, and the total has to come back with the page so
     the screen can say honestly how many matched. */
  N.customersPage=async function(opts){
    const o=opts||{};
    const rows=ok(await sb.rpc('customers_page',{
      p_search:o.search||null, p_filter:o.filter||'all', p_sort:o.sort||'recent',
      p_limit:o.limit||50, p_offset:o.offset||0}));
    return {
      total: rows.length?Number(rows[0].total_count):0,
      rows: rows.map(c=>({_id:c.id,name:c.name,phone:c.contact_phone||'',
        kind:c.kind||'individual',gstin:c.gstin||'',email:c.contact_email||'',
        address:c.billing_address||'',bookings:Number(c.bookings)||0,
        value:Number(c.value)||0,last:c.last_booking||null,
        active:c.is_active!==false}))
    };
  };

  // everything matching the current search, for checking in a spreadsheet
  /* Fetched in chunks. Supabase truncates ANY response at 1,000 rows however
     large a limit the function itself allows, so an export of 9,000 customers
     silently arrived as 1,000 — a spreadsheet that looks complete and is not.
     Paging until a short chunk comes back is the only reliable way. */
  N.customersExport=async function(search,filter,onProgress){
    const PAGE=1000, all=[];
    for(let off=0; ; off+=PAGE){
      const chunk=ok(await sb.rpc('customers_export',{
        p_search:search||null, p_filter:filter||'all',
        p_limit:PAGE, p_offset:off}));
      all.push(...chunk);
      if(onProgress) onProgress(all.length);
      if(chunk.length<PAGE) break;      // a short chunk means the end
      if(all.length>=50000) break;      // a guard, not a limit anyone should meet
    }
    return all;
  };

  // kept for the generic masters loader, which expects a plain array
  N.masters.loadCustomers=async function(){
    const r=await N.customersPage({limit:50});
    r.rows._total=r.total;
    return r.rows;
  };

  N.masters.saveCustomer=async function(v,id){
    // the upsert matches on mobile, so editing a customer's number to one that
    // already exists merges rather than creating a second record
    const cid=ok(await sb.rpc('customer_upsert',{
      p_name:v.name, p_phone:v.phone||null, p_kind:v.kind||'individual',
      p_gstin:v.gstin||null, p_email:v.email||null, p_address:v.address||null}));
    return cid;
  };

  N.masters.setActive=(function(orig){
    return async function(tab,row,on){
      if(tab==='customers')
        return ok(await sb.from('customers').update({is_active:on}).eq('id',row._id));
      return orig.call(this,tab,row,on);
    };
  })(N.masters.setActive);

  /* ---- CSV import ----------------------------------------------------------
     Rows are applied one at a time rather than in a single statement, so one
     bad row reports itself instead of failing the whole file silently. */
  /* Rows are sent to the database in BATCHES, not one at a time. The first
     version called the single-row function per row — two round trips each —
     which meant a 9,000 customer file made ~18,000 requests and took half an
     hour. Batching turns that into about twenty calls.

     500 is a deliberate middle: large enough that the round trips stop
     mattering, small enough that the progress count moves visibly and one
     failed batch loses little. */
  N.importCustomers=async function(rows, onProgress){
    const COLS=['name','phone','kind','gstin','email','address'];
    const BATCH=500;
    if(!rows.length) throw new Error('Nothing to import');

    let head=rows[0].map(h=>String(h||'').toLowerCase().trim().replace(/\s+/g,'_'));
    let body=rows.slice(1);
    if(!head.includes('name')){ head=COLS.slice(); body=rows; }
    const ix={}; COLS.forEach(c=>ix[c]=head.indexOf(c));

    // shape the file into objects, dropping blank lines and flagging repeats
    const out={added:0,updated:0,failed:[]};
    const seen=new Set();
    const items=[];
    body.forEach((r,i)=>{
      if(!r || !r.join('').trim()) return;
      const line=i+2;
      const get=c=>ix[c]<0?'':String(r[ix[c]]==null?'':r[ix[c]]).trim();
      const phone=get('phone').replace(/[^0-9]/g,'');
      /* Only a real 10-digit mobile identifies a person. A landline, a
         nine-digit number or a placeholder like "0" may legitimately belong to
         several customers — two firms can share an office line — so those are
         imported as they stand rather than treated as repeats. */
      const isMobile=/^[6-9][0-9]{9}$/.test(phone);
      if(isMobile && seen.has(phone)){
        out.failed.push('row '+line+': mobile '+phone+' appears more than once in this file');
        return;
      }
      if(isMobile) seen.add(phone);
      items.push({_line:line,name:get('name'),phone:phone,kind:get('kind'),
        gstin:get('gstin'),email:get('email'),address:get('address')});
    });

    for(let i=0;i<items.length;i+=BATCH){
      const chunk=items.slice(i,i+BATCH);
      const res=ok(await sb.rpc('customer_upsert_bulk',{p_rows:chunk}));
      const row=Array.isArray(res)?res[0]:res;
      if(row){
        out.added+=row.added||0;
        out.updated+=row.updated||0;
        (row.failed||[]).forEach(f=>out.failed.push('row '+f.line+
          (f.name?' ('+f.name+')':'')+': '+f.why));
      }
      if(onProgress) onProgress(Math.min(i+BATCH,items.length), items.length);
    }
    return out;
  };
})();

/* ===========================================================================
   Which run is a consignment on, and has that run been closed?

   The delivery screen needs this to stop an agent marking deliveries for a
   vehicle that is still out. The closing KM and diesel are entered when the
   vehicle returns; marking deliveries before that means the run gets closed
   later from memory, or not at all.
   =========================================================================== */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};

  // booking_id -> {trip_number, closed} for every consignment on a run today
  N.runStateFor=async function(bookingIds){
    if(!bookingIds||!bookingIds.length) return {};
    try{
      /* Ask trip_manifest directly.

         The first version walked consignment_items -> trip_items -> trips. But
         consignment_items is one row per PIECE, and these consignments run to
         1000+ pieces each — so that query hit Supabase's 1,000-row cap and the
         item ids that followed were incomplete. Most consignments then looked
         as though they were on no run at all, and the Delivered buttons stayed
         enabled: precisely the failure this check exists to prevent.

         trip_manifest already joins the three tables and carries booking_id,
         so one query does it. It is still one row per piece, so it is paged. */
      const PAGE=1000;
      const seen={};
      const tripIds=new Set();
      for(let off=0;;off+=PAGE){
        const chunk=ok(await sb.from('trip_manifest')
          .select('trip_id,booking_id')
          .in('booking_id',bookingIds)
          .range(off,off+PAGE-1));
        chunk.forEach(x=>{
          if(!seen[x.booking_id]) seen[x.booking_id]=new Set();
          seen[x.booking_id].add(x.trip_id);
          tripIds.add(x.trip_id);
        });
        if(chunk.length<PAGE) break;
        if(off>20000) break;                 // a guard, not a limit anyone meets
      }
      if(!tripIds.size) return {};

      const trips=ok(await sb.from('trips')
        .select('id,trip_number,closed_at').in('id',[...tripIds]));
      const tripById=Object.fromEntries(trips.map(t=>[t.id,t]));

      const out={};
      Object.entries(seen).forEach(([bookingId,ids])=>{
        [...ids].forEach(id=>{
          const t=tripById[id]; if(!t) return;
          // an open run always wins: that is what blocks delivery
          if(!out[bookingId] || (out[bookingId].closed && !t.closed_at))
            out[bookingId]={trip_number:t.trip_number, closed:!!t.closed_at, trip_id:t.id};
        });
      });
      return out;
    }catch(e){
      console.error('run state lookup failed:',e);
      throw new Error('Could not check which run these consignments are on: '+(e.message||e));
    }
  };
})();

/* ===========================================================================
   Optional photo/video attached at booking time — proof of the goods, not a
   required field. One set per CONSIGNMENT (booking_id), not per article line.

   Files live in the public "booking-media" bucket so a customer with the LR
   number can be shown the file link without signing in — the path itself
   (LR/random-id) is what keeps it from being guessed, not a login wall.
   =========================================================================== */
(function(){
  const N=window.N2K, sb=N.sb;
  const ok=r=>{if(r.error)throw r.error;return r.data;};
  const BUCKET='booking-media';

  // kind: 'photo' | 'video'. uploadedByPhone is the staff phone from the
  // session (same pattern saveBooking uses) — resolved to a user id here so
  // the caller never needs to know the uuid. Returns the saved row plus a
  // ready-to-use publicUrl.
  N.bookingMedia = {};
  N.bookingMedia.upload = async function(bookingId, lrNumber, file, kind, uploadedByPhone){
    need_();
    const ext=(file.name.split('.').pop()||(kind==='video'?'mp4':'jpg')).toLowerCase();
    const id=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2));
    const path=lrNumber+'/'+id+'.'+ext;
    const up=await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
    if(up.error) throw up.error;
    let by=null;
    if(uploadedByPhone){
      const ur=ok(await sb.from('users').select('id').eq('phone',uploadedByPhone).limit(1));
      if(ur.length) by=ur[0].id;
    }
    const row=ok(await sb.from('booking_media').insert({
      booking_id: bookingId, kind, storage_path: path,
      file_name: file.name || null, mime_type: file.type || null,
      size_bytes: file.size || null, uploaded_by: by
    }).select('id,kind,storage_path,file_name,created_at'))[0];
    row.publicUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    return row;
  };

  N.bookingMedia.list = async function(bookingId){
    need_();
    const rows=ok(await sb.from('booking_media')
      .select('id,kind,storage_path,file_name,created_at')
      .eq('booking_id', bookingId).order('created_at'));
    return rows.map(r=>({...r, publicUrl: sb.storage.from(BUCKET).getPublicUrl(r.storage_path).data.publicUrl}));
  };

  // bulk presence check for a table of LRs, e.g. the dispatch dashboard —
  // one query for every visible row rather than one query per row.
  // Returns {bookingId: {photo:n, video:n}}, and OMITS ids with nothing
  // attached, so callers can just check `counts[id]` for truthy.
  N.bookingMedia.countsFor = async function(bookingIds){
    need_();
    if(!bookingIds || !bookingIds.length) return {};
    const rows=ok(await sb.from('booking_media').select('booking_id,kind').in('booking_id', bookingIds));
    const out={};
    rows.forEach(r=>{
      if(!out[r.booking_id]) out[r.booking_id]={photo:0,video:0};
      out[r.booking_id][r.kind]=(out[r.booking_id][r.kind]||0)+1;
    });
    return out;
  };

  N.bookingMedia.remove = async function(mediaRow){
    need_();
    await sb.storage.from(BUCKET).remove([mediaRow.storage_path]);
    await sb.from('booking_media').delete().eq('id', mediaRow.id);
  };

  function need_(){ if(!sb) throw new Error('supabase-js not loaded'); }
})();

/* ===========================================================================
   PWA install — one block here covers every page, since every page already
   loads this file.

   Registering the service worker and shipping a manifest only makes the app
   ELIGIBLE to install — most browsers stay completely silent about that
   unless the site itself listens for `beforeinstallprompt` and offers its
   own "Install" button. That part was missing before; this adds it.
   iOS Safari never fires that event at all — "Add to Home Screen" there is
   always a manual step through the Share sheet, so iOS gets a small
   instruction banner instead of a button that would never do anything.
   =========================================================================== */
(function(){
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(e => {
        console.warn('N2K: service worker registration failed —', e.message);
      });
    });
  }

  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const DISMISS_KEY = 'n2k_install_banner_dismissed_at';
  const DISMISS_DAYS = 14;
  const dismissedRecently = () => {
    const t = +localStorage.getItem(DISMISS_KEY) || 0;
    return (Date.now() - t) < DISMISS_DAYS*864e5;
  };
  const dismiss = () => { try{ localStorage.setItem(DISMISS_KEY, String(Date.now())); }catch(e){} closeBanner(); };

  let deferredPrompt = null;
  window.N2K = window.N2K || {};
  window.N2K.pwaStatus = () => ({
    https: location.protocol==='https:' || location.hostname==='localhost',
    serviceWorkerSupported: 'serviceWorker' in navigator,
    serviceWorkerRegistered: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    manifestLinked: !!document.querySelector('link[rel="manifest"]'),
    installPromptCaptured: !!deferredPrompt,
    standalone: isStandalone(),
    isIOS: isIOS()
  });

  function banner(html){
    let b = document.getElementById('n2k-installbar');
    if (b) return b;
    b = document.createElement('div');
    b.id = 'n2k-installbar';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#25315C;color:#fff;'+
      'display:flex;align-items:center;gap:12px;padding:12px 16px;font:600 13px Inter,Arial,sans-serif;'+
      'box-shadow:0 -6px 20px rgba(0,0,0,.18)';
    b.innerHTML = html;
    document.body.appendChild(b);
    return b;
  }
  function closeBanner(){ const b=document.getElementById('n2k-installbar'); if(b) b.remove(); }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (isStandalone() || dismissedRecently()) return;
    const b = banner(
      '<span style="flex:1">Install N2K Logistics on this phone for quick, full-screen access.</span>'+
      '<button id="n2k-install-go" style="border:0;background:#C0392B;color:#fff;font-weight:700;'+
        'padding:8px 14px;border-radius:9px;cursor:pointer">Install</button>'+
      '<button id="n2k-install-x" style="border:0;background:none;color:#fff;opacity:.75;font-size:18px;'+
        'line-height:1;cursor:pointer;padding:4px 6px">×</button>'
    );
    document.getElementById('n2k-install-go').addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
      closeBanner();
      console.log('N2K: install prompt result —', choice.outcome);
    });
    document.getElementById('n2k-install-x').addEventListener('click', dismiss);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    closeBanner();
    try{ localStorage.removeItem(DISMISS_KEY); }catch(e){}
  });

  // iOS never fires beforeinstallprompt — offer the manual steps instead
  window.addEventListener('load', () => {
    if (isIOS() && !isStandalone() && !dismissedRecently()) {
      const b = banner(
        '<span style="flex:1">Install N2K Logistics: tap <b>Share</b> '+
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" '+
          'style="vertical-align:-2px" stroke-linecap="round" stroke-linejoin="round">'+
          '<path d="M12 3v12M7 8l5-5 5 5M5 21h14a2 2 0 002-2v-7a2 2 0 00-2-2h-3M5 21a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>'+
          ' then <b>Add to Home Screen</b>.</span>'+
        '<button id="n2k-install-x" style="border:0;background:none;color:#fff;opacity:.75;font-size:18px;'+
          'line-height:1;cursor:pointer;padding:4px 6px">×</button>'
      );
      document.getElementById('n2k-install-x').addEventListener('click', dismiss);
    }
  });
})();
