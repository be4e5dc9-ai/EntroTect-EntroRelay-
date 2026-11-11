import { createServer } from 'node:http';
export async function modelFixture() {
  const requests: { path: string; body: any }[] = [];
  const usageRequests: { path: string; authorization?: string }[] = [];
  let reply = '第一轮确认完成：ALPHA-731';
  let hold = false;
  let codexContextOverflow = false;
  let nativeAuthorized = true;
  let readFilePath: string | undefined;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/v0/users/get_user_summary') {
      usageRequests.push({ path: req.url, authorization: req.headers['x-dsh-auth-token'] as string | undefined });
      if (!nativeAuthorized) { res.writeHead(401).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: {
        normal_wallets: [{ currency: 'CNY', balance: '12.335' }], bonus_wallets: [{ currency: 'CNY', balance: '5.675' }],
      } } }));
      return;
    }
    if (req.method === 'GET' && (req.url === '/user/balance' || req.url === '/api/monitor/usage/quota/limit')) {
      usageRequests.push({ path: req.url, authorization: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      const balance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.369953420000', granted_balance: '2.369953420000', topped_up_balance: '40' }] };
      const reset = Date.now() + 60_000;
      const quota = { code: 200, success: true, data: { limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 22, nextResetTime: reset },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 49, nextResetTime: reset + 86_400_000 },
      ] } };
      res.end(JSON.stringify(req.url === '/user/balance' ? balance : quota));
      return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url!, body });
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id:'deepseek-flash' },{ id:'glm-5.3' }] })); return; }
    if (codexContextOverflow && req.url?.endsWith('/responses')) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: {
        type: 'invalid_request_error', code: 'context_length_exceeded', message: 'This model’s maximum context length has been exceeded.',
      } }));
      return;
    }
    if (hold) { res.setHeader('Content-Type','text/event-stream'); res.flushHeaders(); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    if (req.url?.endsWith('/responses')) {
      const send = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      const message = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply, annotations: [] }] };
      const response = { id: 'resp_fixture', object: 'response', model: body.model, created_at: Math.floor(Date.now() / 1000), status: 'completed', output: [message], usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      send('response.created', { response: { ...response, status: 'in_progress', output: [] } });
      send('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
      send('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: reply });
      send('response.output_item.done', { output_index: 0, item: message });
      send('response.completed', { response });
      res.end();
    } else if (req.url?.includes('messages')) {
      const send = (type: string, value: any) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      send('message_start', { type:'message_start', message:{id:`msg_${Date.now()}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,usage:{input_tokens:80,output_tokens:0}} });
      send('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}});
      send('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:reply}});
      send('content_block_stop',{type:'content_block_stop',index:0});
      send('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:20}});
      send('message_stop',{type:'message_stop'});res.end();
    } else {
      const base={id:`chat_${Date.now()}`,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:body.model};
      const reader = readFilePath && body.tools?.map((tool: any) => tool.function).find((tool: any) => /^read(?:_?file)?$/i.test(tool?.name));
      const fileArgument = reader && Object.keys(reader.parameters?.properties ?? {}).find(key => /^(?:file_?path|path)$/i.test(key));
      const toolCall = fileArgument && { index: 0, id: 'call_entrotect_fixture_read', type: 'function', function: { name: reader.name, arguments: JSON.stringify({ [fileArgument]: readFilePath }) } };
      if (toolCall) readFilePath = undefined;
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',...(toolCall ? { tool_calls: [toolCall] } : { content: reply })},finish_reason:null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:toolCall ? 'tool_calls' : 'stop'}],usage:{prompt_tokens:80,completion_tokens:20,total_tokens:100}})}\n\n`);
      res.end('data: [DONE]\n\n');
    }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return { origin:`http://127.0.0.1:${(server.address() as any).port}`,requests,usageRequests,reply(value: string){reply=value;},hold(value:boolean){hold=value;},codexContextOverflow(value:boolean){codexContextOverflow=value;},readFile(value: string){readFilePath=value;},nativeAuthorized(value:boolean){nativeAuthorized=value;},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));} };
}
