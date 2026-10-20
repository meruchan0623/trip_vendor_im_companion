using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace TripVendorInstaller;

sealed record PayloadArchiveMetadata(string Kind,long ZipBytes,string ZipSha256,long CompressedBytes,string CompressedSha256,int BrotliQuality);
static class PayloadArchive {
    internal const long MaximumBytes=1024L*1024*1024;
    static readonly Regex HashPattern=new("^[a-fA-F0-9]{64}$",RegexOptions.CultureInvariant);
    static void Require(bool value,string code){if(!value)throw new InvalidDataException(code);}
    internal static void Validate(PayloadArchiveMetadata metadata,long maximumBytes=MaximumBytes){
        Require(maximumBytes>0&&maximumBytes<=MaximumBytes&&metadata.Kind=="zip+brotli-v1"&&metadata.ZipBytes>0&&metadata.ZipBytes<=maximumBytes&&metadata.CompressedBytes>0&&metadata.CompressedBytes<=maximumBytes&&metadata.BrotliQuality==8&&HashPattern.IsMatch(metadata.ZipSha256??"")&&HashPattern.IsMatch(metadata.CompressedSha256??""),"PAYLOAD_ARCHIVE_METADATA_INVALID");
    }
    internal static void Extract(Stream compressed,string destination,PayloadArchiveMetadata metadata,long maximumBytes=MaximumBytes){
        Validate(metadata,maximumBytes);
        // Embedded resources are seekable. Bind the exact compressed stream too:
        // Brotli itself has no checksum and a truncated end can otherwise look like EOF.
        Require(compressed.CanSeek&&compressed.Length==metadata.CompressedBytes,"PAYLOAD_ARCHIVE_COMPRESSED_LENGTH_MISMATCH");
        compressed.Position=0;
        Require(Convert.ToHexStringLower(SHA256.HashData(compressed)).Equals(metadata.CompressedSha256,StringComparison.OrdinalIgnoreCase),"PAYLOAD_ARCHIVE_COMPRESSED_HASH_MISMATCH");
        compressed.Position=0;var created=false;
        try{
            using var output=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None);created=true;
            using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using var decoder=new BrotliStream(compressed,CompressionMode.Decompress,leaveOpen:true);
            var buffer=new byte[128*1024];long written=0;int count;
            while((count=decoder.Read(buffer))>0){
                written=checked(written+count);
                Require(written<=maximumBytes&&written<=metadata.ZipBytes,"PAYLOAD_ARCHIVE_DECOMPRESSED_LIMIT_EXCEEDED");
                output.Write(buffer,0,count);hash.AppendData(buffer,0,count);
            }
            Require(written==metadata.ZipBytes,"PAYLOAD_ARCHIVE_LENGTH_MISMATCH");
            Require(Convert.ToHexStringLower(hash.GetHashAndReset()).Equals(metadata.ZipSha256,StringComparison.OrdinalIgnoreCase),"PAYLOAD_ARCHIVE_HASH_MISMATCH");
            output.Flush(true);
        }catch(Exception error){
            if(created)try{File.Delete(destination);}catch(Exception cleanup){error.Data["PayloadArchiveCleanupError"]=cleanup.Message;}
            // Preserve the original decoder/hash/I/O failure. Program's staging
            // cleanup still runs and records any directory it cannot remove.
            throw;
        }
    }
}
