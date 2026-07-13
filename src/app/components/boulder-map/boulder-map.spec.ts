import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BoulderMap } from './boulder-map';

describe('BoulderMap', () => {
  let component: BoulderMap;
  let fixture: ComponentFixture<BoulderMap>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BoulderMap],
    }).compileComponents();

    fixture = TestBed.createComponent(BoulderMap);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
