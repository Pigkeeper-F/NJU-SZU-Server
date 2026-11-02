'use strict';
// Read-only counterpart of literature_metadata.py. No browser/network access.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const VERSION = 'article-metadata-v1';
const str = v => typeof v === 'string' ? v.trim() : '';
const text = v => String(v || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase().replace(/ß/gu,'ss').replace(/ς/gu,'σ');
const key = v => text(v).replace(/[^\p{L}\p{N}]/gu, '');
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = v => createHash('sha256').update(JSON.stringify(canonical(v)), 'utf8').digest('hex');
function authors(record) {
  const value = record.authors || '';
  return Array.isArray(value) ? value.map(v => v && typeof v === 'object' ? v.name || '' : String(v)).join(';') : String(value);
}
function sourceIds(record) {
  const result = record.source_identifiers && !Array.isArray(record.source_identifiers) && typeof record.source_identifiers === 'object'
    ? Object.fromEntries(Object.entries(record.source_identifiers).filter(([,v]) => v).map(([k,v]) => [k,text(v)])) : {};
  for (const [field, ns] of [['ut','web-of-science'],['eid','scopus'],['pmid','pubmed'],['cnki_id','cnki']]) if(record[field])result[ns]=text(record[field]);
  const source=String(record.source_key||'');
  if(record.accession_number && source && !(source in result))result[source]=text(record.accession_number);
  try {
    const url=new URL(record.source_url || record.result_url || ''), query={};
    for(const [k,v] of url.searchParams){(query[k.toLowerCase()] ||= []).push(v);}
    if(source==='scopus' && query.eid && !result.scopus)result.scopus=text(query.eid[0]);
    if(source==='cnki' && url.hostname==='kns.cnki.net' && !result.cnki){
      const parts=['dbcode','dbname','filename'].map(k=>query[k]||[]);
      if(parts.every(v=>v.length===1&&/^[\p{L}\p{N}_.-]{1,100}$/u.test(v[0])))result.cnki=parts.map(v=>text(v[0])).join(':');
    }
  }catch{}
  return result;
}
function identity(record) {
  const year=String(record.year||'');
  return {doi:text(record.doi).replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)/i,''),
    source_ids:sourceIds(record),title:key(record.title),year:/^\d{4}$/.test(year)?year:'',
    authors:key(authors(record)),document_type:text(record.document_type)};
}
function recordHash(record) {
  return digest(['candidate_id','source_key','title','doi','source_url','result_url','abstract_url'].map(k=>str(record[k]))
    .concat([String(record.year||''),authors(record),sourceIds(record)]));
}
function match(left,right) {
  if(left.doi && right.doi && left.doi!==right.doi)return '';
  const a=left.source_ids||{},b=right.source_ids||{},both=Object.keys(a).filter(k=>k in b);
  if(both.some(k=>a[k]!==b[k]))return '';
  if(left.doi && left.doi===right.doi)return 'doi_exact';
  if(both.some(k=>a[k]===b[k]))return 'source_id_exact';
  if(left.document_type && right.document_type && left.document_type!==right.document_type)return '';
  return left.title.length>=8 && left.title===right.title && left.year && left.year===right.year
    && left.authors.length>=2 && left.authors===right.authors?'title_year_authors_exact':'';
}
function loadMetadata(jobDir) {
  const file=path.join(jobDir,'metadata','status.json');
  if(!fs.existsSync(file))return {version:VERSION,items:{}};
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(value?.version!==VERSION || !value.items || typeof value.items!=='object' || Array.isArray(value.items))throw new Error('摘要回源记录不可核验。');
  return value;
}
function existingAbstract(record) {
  const abstract=str(record.abstract) || (['imported_abstract','source_abstract','verified_abstract'].includes(record.evidence_level)?str(record.snippet):'');
  return record.abstract_complete===false || record.abstract_truncated===true
    || /(?:\.{3}|…|read more|show more|展开|更多)\s*$/i.test(abstract)?'':abstract;
}
function validatedEvidence(record,entry) {
  if(!entry || entry.status!=='verified' || entry.record_sha256!==recordHash(record))return null;
  const evidence=entry.evidence;
  if(!evidence || entry.evidence_sha256!==digest(evidence) || digest(evidence.expected_identity)!==digest(identity(record)))return null;
  const expected=evidence.expected_identity, observed=evidence.observed_identity||{}, method=match(expected,observed);
  if(!method || method!==evidence.identity_match || !expected.title || expected.title!==observed.title
    || evidence.abstract_complete!==true || !['explicit_abstract_dom','citation_abstract_meta'].includes(evidence.abstract_method)
    || !str(evidence.abstract))return null;
  try {const u=new URL(evidence.source_url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;}catch{return null;}
  return evidence;
}
function mergeRecord(record,state) {
  const entry=state?.items?.[record.candidate_id], evidence=validatedEvidence(record,entry);
  if(!evidence || existingAbstract(record))return record;
  return {...record,abstract:evidence.abstract,evidence_level:'verified_abstract',abstract_complete:true,abstract_truncated:false,metadata_keywords:evidence.keywords,
    metadata_evidence:{path:'metadata/status.json',source_url:evidence.source_url,sha256:entry.evidence_sha256,identity_match:evidence.identity_match}};
}
module.exports={VERSION,recordHash,identity,loadMetadata,validatedEvidence,mergeRecord,existingAbstract};
