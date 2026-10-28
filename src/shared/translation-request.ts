import type {OutboundBody} from './workbench';

/** Shared by the owned and Windows browser-session HTTP exits. Legacy TSIM
 * servers forbid extra fields, so the FIRST request uses this six-field shape.
 * Keep client_source/protocol out until capability is known before sending;
 * never discover compatibility by retrying a potentially billable 422. */
export function outboundTranslationBody(body:OutboundBody):OutboundBody {
  return {text:body.text,target_lang:body.target_lang,source_lang:body.source_lang,purpose:body.purpose,
    draft_request_id:body.draft_request_id,composer_content_version:body.composer_content_version};
}
