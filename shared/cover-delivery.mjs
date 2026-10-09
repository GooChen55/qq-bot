export async function deliverCover({job,base,sendRecord,sendFile,sendText}) {
 const full=base+'/audio/'+job.output,short=base+'/audio/'+job.clip;
 if(job.deliveryMode==='full_voice') {
  try {await sendRecord(full);return {voice:true};}
  catch(e) {
   // Never resend another voice after an ambiguous timeout; provide the file.
   await sendText('完整语音发送失败或状态未确认，改发完整 MP3 文件：'+e.message);
   if(!sendFile)throw Error('当前通道没有文件发送能力；请在本地面板下载完整 MP3');
   await sendFile(job.output,job.fileName);return {file:true,voiceUnconfirmed:true};
  }
 }
 let voiceError;
 try {await sendRecord(short);}catch(e){voiceError=e;}
 if(!sendFile)throw Error('当前通道没有文件发送能力；请在本地面板下载完整 MP3');
 await sendFile(job.output,job.fileName);
 if(voiceError)await sendText('完整 MP3 已提交；短语音发送失败或状态未确认：'+voiceError.message);
 return {voice:!voiceError,file:true};
}
