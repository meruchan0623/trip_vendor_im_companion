using System.Security.Cryptography;
using System.Text;

namespace TripVendorInstaller;

static class InstallerLog {
    static readonly UTF8Encoding Encoding=new(false);
    internal static string Read(string path){
        using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete);
        using var reader=new StreamReader(stream,Encoding);
        return reader.ReadToEnd();
    }
    internal static void Append(string path,string line){
        try{
            // UAC parent and child share this path. Serialize their appends across processes;
            // UI readers explicitly share write access and never block operation logging.
            var key=Convert.ToHexString(SHA256.HashData(Encoding.GetBytes(Path.GetFullPath(path).ToUpperInvariant())));
            using var mutex=new Mutex(false,@"Local\TripVendorInstallerLog-"+key);
            var acquired=false;
            try{
                try{acquired=mutex.WaitOne(2000);}catch(AbandonedMutexException){acquired=true;}
                if(!acquired)throw new IOException("INSTALLER_LOG_MUTEX_TIMEOUT");
                for(var retry=0;;retry++)try{
                    using var stream=new FileStream(path,FileMode.Append,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete);
                    using var writer=new StreamWriter(stream,Encoding);
                    writer.WriteLine(line);break;
                }catch(IOException)when(retry<9){Thread.Sleep(50);}
            }finally{if(acquired)mutex.ReleaseMutex();}
        }catch(Exception error){
            // A log-sharing failure must not turn an active elevated installation into a false failure.
            // Keep the original operation error (if any) in a separate, process-specific diagnostic file.
            var fallback=path+"."+Environment.ProcessId+".fallback.log";
            Console.Error.WriteLine("INSTALLER_LOG_WRITE_FAILED: "+error.Message+"; fallback="+fallback);
            try{File.AppendAllText(fallback,line+Environment.NewLine+"INSTALLER_LOG_WRITE_FAILED: "+error.Message+Environment.NewLine,Encoding);}catch(Exception fallbackError){Console.Error.WriteLine("INSTALLER_LOG_FALLBACK_FAILED: "+fallbackError.Message);}
        }
    }
}
