#include "LekhTextService.h"

#include "Guids.h"

#include <new>
#include <windows.h>

extern long g_lockCount;

class LekhClassFactory final : public IClassFactory {
public:
  STDMETHODIMP QueryInterface(REFIID riid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (riid == IID_IUnknown || riid == IID_IClassFactory) {
      *object = static_cast<IClassFactory*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }

  STDMETHODIMP_(ULONG) AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&refCount_));
  }

  STDMETHODIMP_(ULONG) Release() override {
    const ULONG ref = static_cast<ULONG>(InterlockedDecrement(&refCount_));
    if (ref == 0) delete this;
    return ref;
  }

  STDMETHODIMP CreateInstance(IUnknown* outer, REFIID iid, void** object) override {
    if (outer) return CLASS_E_NOAGGREGATION;
    if (!object) return E_POINTER;
    auto* service = new (std::nothrow) LekhTextService();
    if (!service) return E_OUTOFMEMORY;
    const HRESULT hr = service->QueryInterface(iid, object);
    service->Release();
    return hr;
  }

  STDMETHODIMP LockServer(BOOL lock) override {
    if (lock) {
      InterlockedIncrement(&g_lockCount);
    } else {
      InterlockedDecrement(&g_lockCount);
    }
    return S_OK;
  }

private:
  long refCount_ = 1;
};

STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** object) {
  if (clsid != CLSID_LekhTextService) return CLASS_E_CLASSNOTAVAILABLE;
  auto* factory = new (std::nothrow) LekhClassFactory();
  if (!factory) return E_OUTOFMEMORY;
  const HRESULT hr = factory->QueryInterface(iid, object);
  factory->Release();
  return hr;
}
