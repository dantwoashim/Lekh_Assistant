#include <windows.h>

// inputscope.h declares GUID_PROP_INPUTSCOPE and the ITfInputScope interface
// identifiers with DEFINE_GUID. The Windows SDK import libraries do not
// provide GUID_PROP_INPUTSCOPE on every supported toolchain, so instantiate
// the SDK declarations in exactly one translation unit.
#include <initguid.h>
#include <inputscope.h>
