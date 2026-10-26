using System.Diagnostics;

int checks = 0;
void Check(bool value, string code) {
    if (!value) throw new InvalidOperationException(code);
    checks++;
}
void Reject(Action action, string code) {
    bool rejected = false;
    try { action(); } catch (InvalidOperationException) { rejected = true; }
    Check(rejected, code);
}

if (args.Length != 1 || !uint.TryParse(args[0], out var expectedParent)) throw new ArgumentException("expected_parent_required");
var watch = Stopwatch.StartNew();
for (int i = 0; i < 32; i++)
    Check(NativeTargetBinding.ParentProcessId((uint)Environment.ProcessId) == expectedParent, "snapshot_parent_mismatch");
watch.Stop();
Reject(() => NativeTargetBinding.ParentProcessId(0), "zero_pid_accepted");
Reject(() => NativeTargetBinding.ParentProcessId(uint.MaxValue), "missing_pid_accepted");

const string executable = @"C:\Program Files\vbk-electron\旅游商家桌面版.exe";
const string helper = @"C:\Program Files\vbk-electron\resources\TripVendorCompanion\旅游商家助手.exe";
string native = @"C:\Program Files\vbk-electron" + NativeTargetBinding.NativeSuffix;
var binding = NativeTargetBinding.Parse(["--vendor-executable", executable, "--vendor-owner", "46824"], native);
Check(binding.Executable == executable && binding.Owner == 46824, "binding_parse_failed");
Reject(() => NativeTargetBinding.Parse([], native), "installed_unbound_accepted");
Reject(() => NativeTargetBinding.Parse(["--vendor-executable", @"C:\Other\旅游商家桌面版.exe", "--vendor-owner", "46824"], native), "other_root_accepted");
NativeTargetBinding.ValidateOwner(executable, 46824, helper, "\"" + helper + "\" --vendor-owner=46824", executable, 100, 200, 300);
checks++;
void BadOwner(string image, string command, string ownerImage, long ownerStart, long parentStart, long nativeStart, string code) =>
    Reject(() => NativeTargetBinding.ValidateOwner(executable, 46824, image, command, ownerImage, ownerStart, parentStart, nativeStart), code);
BadOwner(helper + ".other", "--vendor-owner=46824", executable, 100, 200, 300, "other_helper_accepted");
BadOwner(helper, "--vendor-owner=46824", executable + ".other", 100, 200, 300, "other_owner_accepted");
BadOwner(helper, "--vendor-owner=999", executable, 100, 200, 300, "wrong_owner_accepted");
BadOwner(helper, "--vendor-owner=46824 --vendor-owner=46824", executable, 100, 200, 300, "duplicate_owner_accepted");
BadOwner(helper, "--vendor-owner=46824", executable, 201, 200, 300, "owner_started_after_parent_accepted");
BadOwner(helper, "--vendor-owner=46824", executable, 100, 301, 300, "parent_started_after_native_accepted");
BadOwner(helper, "--vendor-owner=46824", executable, 0, 200, 300, "missing_start_accepted");
Console.WriteLine($"native_target_binding_tests_pass checks={checks} snapshot_32_ms={watch.ElapsedMilliseconds}");
